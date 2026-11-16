import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, desc, eq, isNotNull, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { config } from '../config.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';

const s = schema;
const DAY = 86_400_000;
type Row = Record<string, unknown>;
/** ชนิดเอกสารเดียวกับ apps/api (public.service › LEGAL_TYPES) */
export const LEGAL_TYPES = ['terms', 'privacy', 'dpa', 'cookie', 'subprocessors'] as const;
/** เปลี่ยนสาระสำคัญต้องแจ้งล่วงหน้าอย่างน้อย 30 วัน (A7) */
export const NOTICE_DAYS = 30;
/** เตือนซ้ำก่อนวันมีผล (H14) */
export const REMIND_DAYS = 7;
/** ส่งอีเมลแจ้งเอกสารทีละชุด (แบบประกาศ) · งานทุก 1 นาที */
export const NOTICE_BATCH = 50;
const DOC_NAME: Record<string, string> = { terms: 'ข้อกำหนดการใช้งาน', privacy: 'นโยบายความเป็นส่วนตัว', dpa: 'ข้อตกลงการประมวลผลข้อมูล (DPA)', cookie: 'นโยบายคุกกี้', subprocessors: 'รายชื่อผู้ประมวลผลข้อมูลช่วง' };
const thaiDate = (d: Date) => new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' }).format(d);

export const CreateVersionBody = z
  .object({
    docType: z.enum(LEGAL_TYPES),
    version: z.string().trim().regex(/^\d+(\.\d+)*$/, 'เวอร์ชันเป็นตัวเลข เช่น 3 หรือ 3.1'),
    locale: z.enum(['th', 'en']).default('th'),
    /** สรุปการเปลี่ยนแปลงที่ลูกค้าเห็น */
    summary: z.string().trim().min(10).max(1000),
    body: z.string().trim().min(50).max(200_000),
    effectiveAt: z.iso.datetime({ offset: true }),
    /** true = ต้องกดยอมรับใหม่ · false = แจ้งให้ทราบ */
    requiresAcceptance: z.boolean(),
    /** แจ้งลูกค้าทางอีเมล (H14) · all = ผู้ใช้ทุกคนที่ใช้งานอยู่ (ค่าเริ่มต้น · คำตัดสินข้อ 5) · admins = Owner / Admin · none = ไม่ส่ง */
    notifyAudience: z.enum(['all', 'admins', 'none']).default('all'),
    /** เวลาส่งอีเมล · ไม่ระบุ = ทันทีที่เผยแพร่ */
    notifyAt: z.iso.datetime({ offset: true }).optional(),
    /** เตือนอีกครั้ง 7 วันก่อนมีผล */
    remind: z.boolean().default(true),
    /** แบนเนอร์ในแอปตั้งแต่วันนี้ถึงวันที่มีผล */
    notifyBanner: z.boolean().default(true),
  })
  .strict();
export const AcceptancesQuery = z.object({
  q: z.string().trim().max(100).optional(),
  docType: z.enum(LEGAL_TYPES).optional(),
  version: z.string().trim().max(20).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

/**
 * เอกสารกฎหมาย (O05 · หน้า Legal · A7) · ทุกเวอร์ชันเก็บถาวร แก้ย้อนหลังไม่ได้ (ไม่มี endpoint แก้)
 * เผยแพร่ตามเวลา = API ลูกค้าแสดงเฉพาะฉบับที่ effective_at ผ่านแล้ว (public.service › latest)
 */
@Injectable()
export class LegalService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('LegalNotices');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly mail: Mailer,
  ) {}

  onModuleInit() {
    // ส่งอีเมลแจ้งเอกสารที่ถึงเวลา ทุก 1 นาที ชุดละ 50 (H15) · test เรียก tick() เอง
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      this.timer = setInterval(() => void this.tick().catch((e) => this.log.error(String(e))), 60_000);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async rows<T = Row>(q: SQL) {
    const r = await this.db.execute(q);
    return ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as T[];
  }

  /** ทุกชนิด: ฉบับที่ใช้อยู่ ฉบับที่ตั้งเวลาไว้ จำนวนผู้ยอมรับ และผู้ใช้ที่ยังต้องยอมรับ */
  async documents() {
    const docs = await this.rows<Row>(sql`
      select d.id, d.doc_type as "docType", d.version, d.locale, d.effective_at as "effectiveAt", d.summary, d.requires_acceptance as "requiresAcceptance",
        d.created_at as "createdAt", st.name as "createdBy",
        d.notify_audience as "notifyAudience", d.notify_at as "notifyAt", d.remind_at as "remindAt", d.notified_at as "notifiedAt", d.reminded_at as "remindedAt", d.notify_banner as "notifyBanner",
        (select count(*)::int from legal_acceptances a where a.document_id = d.id) as accepted,
        (select count(*)::int from legal_notices n where n.document_id = d.id and n.kind = 'notice' and n.status = 'sent') as "noticeSent",
        (select count(*)::int from legal_notices n where n.document_id = d.id and n.kind = 'notice' and n.status in ('failed', 'suppressed')) as "noticeBounced",
        (select count(*)::int from legal_notices n where n.document_id = d.id and n.kind = 'notice') as "noticeTotal",
        (select count(*)::int from legal_notices n where n.document_id = d.id and n.kind = 'reminder' and n.status = 'sent') as "reminderSent"
      from legal_documents d left join staff_users st on st.id = d.created_by_staff
      order by d.doc_type, d.locale, d.effective_at desc`);
    const [{ users }] = await this.rows<{ users: number }>(sql`select count(*)::int as users from users where disabled_at is null`);
    const now = Date.now();
    const groups = LEGAL_TYPES.flatMap((type) =>
      (['th', 'en'] as const).map((locale) => {
        const list = docs.filter((d) => d.docType === type && d.locale === locale);
        const current = list.find((d) => new Date(d.effectiveAt as string).getTime() <= now) ?? null;
        return {
          docType: type,
          locale,
          current: current ? { ...current, pendingUsers: current.requiresAcceptance ? Math.max(0, users - Number(current.accepted)) : null } : null,
          scheduled: list.filter((d) => new Date(d.effectiveAt as string).getTime() > now),
          history: list.filter((d) => new Date(d.effectiveAt as string).getTime() <= now),
        };
      }),
    ).filter((g) => g.current || g.scheduled.length);
    return { items: groups, activeUsers: users };
  }

  /** ผู้รับที่จะได้อีเมล (H14): ผู้ใช้ทุกคนที่ใช้งานอยู่ / Owner และ Admin · ข้ามอีเมลที่ตีกลับถาวร */
  async audience() {
    const [r] = await this.rows<{ all: number; workspaces: number; admins: number; suppressed: number }>(sql`
      with people as (
        select u.id, u.email, bool_or(m.role in ('owner', 'admin')) as admin
        from users u join workspace_members m on m.user_id = u.id and m.status = 'active' join workspaces w on w.id = m.workspace_id and w.deleted_at is null
        where u.disabled_at is null group by u.id, u.email)
      select (select count(*)::int from people) as "all",
             (select count(distinct m.workspace_id)::int from workspace_members m join workspaces w on w.id = m.workspace_id and w.deleted_at is null where m.status = 'active') as workspaces,
             (select count(*)::int from people where admin) as admins,
             (select count(*)::int from people p where exists (select 1 from email_suppressions x where lower(x.email) = lower(p.email) and x.removed_at is null and x.reason = 'hard_bounce')) as suppressed`);
    return r;
  }

  /**
   * ส่งอีเมลแจ้งเอกสารฉบับใหม่ (H15) ชุดละ 50 ต่อรอบ · ฉบับที่ถึง notify_at แล้วก่อน แล้วค่อยเตือนซ้ำเมื่อถึง remind_at
   * legal_notices กันส่งซ้ำ (document, user, kind) · อีเมลกฎหมายเป็นการแจ้งเรื่องบริการ จึงส่งแม้ผู้ใช้ปิดอีเมลข่าวสาร · ข้ามเฉพาะที่ตีกลับถาวร
   */
  async tick(now = new Date()) {
    let sent = 0;
    let budget = NOTICE_BATCH;
    for (const kind of ['notice', 'reminder'] as const) {
      const at = kind === 'notice' ? s.legalDocuments.notifyAt : s.legalDocuments.remindAt;
      const done = kind === 'notice' ? s.legalDocuments.notifiedAt : s.legalDocuments.remindedAt;
      const due = await this.db
        .select()
        .from(s.legalDocuments)
        .where(and(isNotNull(s.legalDocuments.notifyAudience), isNotNull(at), lte(at, now), isNull(done), kind === 'reminder' ? sql`${s.legalDocuments.effectiveAt} > ${now}` : undefined))
        .orderBy(at)
        .limit(5);
      for (const d of due) {
        if (budget <= 0) return { sent };
        const r = await this.sendBatch(d, kind, budget, now);
        sent += r.sent;
        budget -= r.processed;
      }
    }
    return { sent };
  }

  private async sendBatch(d: typeof s.legalDocuments.$inferSelect, kind: 'notice' | 'reminder', limit: number, now: Date) {
    const admins = d.notifyAudience === 'admins' ? sql`and m.role in ('owner', 'admin')` : sql``;
    const people = await this.rows<{ id: string; email: string; name: string; suppressed: boolean }>(sql`
      select u.id, u.email, u.display_name as name,
        exists (select 1 from email_suppressions x where lower(x.email) = lower(u.email) and x.removed_at is null and x.reason = 'hard_bounce') as suppressed
      from users u
      where u.disabled_at is null
        and exists (select 1 from workspace_members m join workspaces w on w.id = m.workspace_id and w.deleted_at is null where m.user_id = u.id and m.status = 'active' ${admins})
        and not exists (select 1 from legal_notices n where n.document_id = ${d.id} and n.user_id = u.id and n.kind = ${kind})
      order by u.created_at, u.id limit ${limit}`);
    if (!people.length) {
      const set = kind === 'notice' ? { notifiedAt: now } : { remindedAt: now };
      const [row] = await this.db.update(s.legalDocuments).set(set).where(and(eq(s.legalDocuments.id, d.id), kind === 'notice' ? isNull(s.legalDocuments.notifiedAt) : isNull(s.legalDocuments.remindedAt))).returning({ id: s.legalDocuments.id });
      if (row) {
        const [c] = await this.rows<{ sent: number; bounced: number }>(sql`select count(*) filter (where status = 'sent')::int as sent, count(*) filter (where status <> 'sent')::int as bounced from legal_notices where document_id = ${d.id} and kind = ${kind}`);
        await staffAudit(this.db, null, kind === 'notice' ? 'legal.notice_sent' : 'legal.reminder_sent', `${d.docType} v${d.version} (${d.locale}) ${kind === 'notice' ? 'แจ้ง' : 'เตือนซ้ำ'}ทางอีเมลแล้ว ${c.sent} คน · ตีกลับ / ข้าม ${c.bounced}`, { type: 'legal_document', id: d.id });
      }
      return { sent: 0, processed: 0 };
    }
    let sent = 0;
    const name = DOC_NAME[d.docType] ?? d.docType;
    const changes = d.summary.split(/\n|·/).map((x) => x.trim()).filter(Boolean);
    for (const p of people) {
      let status: 'sent' | 'failed' | 'suppressed' = 'sent';
      let error: string | null = null;
      if (p.suppressed) status = 'suppressed';
      else {
        try {
          await this.mail.send({
            to: p.email,
            subject: `${kind === 'reminder' ? 'เตือน: ' : ''}${name}ฉบับใหม่มีผล ${thaiDate(d.effectiveAt)}`,
            text: [
              `คุณ${p.name} · เราปรับ${name} Friday Work Management มีผลวันที่ ${thaiDate(d.effectiveAt)}`,
              '',
              'สิ่งที่เปลี่ยน',
              ...changes.map((c) => `- ${c}`),
              '',
              d.requiresAcceptance ? 'ตั้งแต่วันที่มีผล คุณต้องกดยอมรับครั้งแรกที่เข้าใช้งาน' : 'ฉบับนี้แจ้งให้ทราบ ไม่ต้องกดยอมรับ',
              `อ่านฉบับเต็มและเทียบกับฉบับเดิม: ${config.appUrl}/legal/${d.docType}`,
              '',
              'อีเมลแจ้งเรื่องข้อกำหนดของบริการ ส่งถึงผู้ใช้ทุกคน',
            ].join('\n'),
          });
          sent++;
        } catch (e) {
          status = 'failed';
          error = (e as Error).message.slice(0, 300);
        }
      }
      await this.db.insert(s.legalNotices).values({ documentId: d.id, userId: p.id, email: p.email, kind, status, error }).onConflictDoNothing();
    }
    return { sent, processed: people.length };
  }

  async get(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบเอกสาร');
    const [d] = await this.db.select().from(s.legalDocuments).where(eq(s.legalDocuments.id, id));
    if (!d) throw new AppError(404, 'not_found', 'ไม่พบเอกสาร');
    // ฉบับก่อนหน้าไว้เทียบความต่าง
    const [prev] = await this.db
      .select({ id: s.legalDocuments.id, version: s.legalDocuments.version, body: s.legalDocuments.body, effectiveAt: s.legalDocuments.effectiveAt })
      .from(s.legalDocuments)
      .where(and(eq(s.legalDocuments.docType, d.docType), eq(s.legalDocuments.locale, d.locale), sql`${s.legalDocuments.effectiveAt} < ${d.effectiveAt}`))
      .orderBy(desc(s.legalDocuments.effectiveAt))
      .limit(1);
    return { document: d, previous: prev ?? null };
  }

  /**
   * สร้างเวอร์ชันใหม่และตั้งเวลาเผยแพร่ (A7) · เวอร์ชันต้องใหม่กว่าฉบับล่าสุด
   * ต้องยอมรับใหม่ = มีผลไม่เร็วกว่า 30 วันจากวันนี้ · แจ้งให้ทราบ = มีผลตั้งแต่ตอนนี้ได้
   */
  async create(staff: Staff, input: z.infer<typeof CreateVersionBody>) {
    const effective = new Date(input.effectiveAt);
    const minDate = Date.now() + (input.requiresAcceptance ? NOTICE_DAYS * DAY : 0) - 60_000;
    if (effective.getTime() < minDate) throw new AppError(422, 'notice_too_short', input.requiresAcceptance ? `เปลี่ยนสาระสำคัญต้องมีผลหลังวันนี้อย่างน้อย ${NOTICE_DAYS} วัน` : 'วันที่มีผลต้องไม่ย้อนหลัง', { minEffectiveAt: new Date(minDate + 60_000) });
    const [latest] = await this.db
      .select({ version: s.legalDocuments.version, effectiveAt: s.legalDocuments.effectiveAt })
      .from(s.legalDocuments)
      .where(and(eq(s.legalDocuments.docType, input.docType), eq(s.legalDocuments.locale, input.locale)))
      .orderBy(desc(s.legalDocuments.effectiveAt))
      .limit(1);
    const cmp = (a: string, b: string) => {
      const x = a.split('.').map(Number);
      const y = b.split('.').map(Number);
      for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
      return 0;
    };
    if (latest && cmp(input.version, latest.version) <= 0) throw new AppError(409, 'version_not_newer', `เวอร์ชันต้องใหม่กว่า ${latest.version}`, { latest: latest.version });
    if (latest && effective.getTime() <= latest.effectiveAt.getTime()) throw new AppError(422, 'effective_before_latest', 'วันที่มีผลต้องหลังฉบับล่าสุด');
    const notifyAt = input.notifyAt ? new Date(input.notifyAt) : new Date();
    if (input.notifyAudience !== 'none' && input.notifyAt && notifyAt.getTime() > effective.getTime()) throw new AppError(422, 'notify_after_effective', 'เวลาส่งอีเมลต้องไม่หลังวันที่มีผล');
    const remindAt = new Date(effective.getTime() - REMIND_DAYS * DAY);
    const notify = input.notifyAudience === 'none' ? null : input.notifyAudience;
    const [row] = await this.db
      .insert(s.legalDocuments)
      .values({
        docType: input.docType, version: input.version, locale: input.locale, summary: input.summary, body: input.body, effectiveAt: effective, requiresAcceptance: input.requiresAcceptance, createdByStaff: staff.id,
        notifyAudience: notify, notifyAt: notify ? notifyAt : null,
        // เตือนซ้ำเมื่อวันเตือนยังอยู่หลังวันส่งครั้งแรก (มีผลเร็วกว่า 7 วัน = ไม่ต้องเตือน)
        remindAt: notify && input.remind && remindAt.getTime() > notifyAt.getTime() ? remindAt : null,
        notifyBanner: input.notifyBanner,
      })
      .returning();
    const how = notify ? `แจ้งอีเมล${notify === 'all' ? 'ผู้ใช้ทุกคน' : ' Owner / Admin'} ${input.notifyAt ? thaiDate(notifyAt) : 'ทันที'}${row.remindAt ? ` · เตือน ${thaiDate(row.remindAt)}` : ''}` : 'ไม่แจ้งทางอีเมล';
    await staffAudit(this.db, staff, 'legal.version_scheduled', `${input.docType} v${input.version} (${input.locale}) มีผล ${effective.toISOString()} · ${input.requiresAcceptance ? 'ต้องยอมรับใหม่' : 'แจ้งให้ทราบ'} · ${how} · ${input.summary}`, { type: 'legal_document', id: row.id });
    // ส่งทันที: ชุดแรกออกเลย ชุดถัดไปตามงานทุกนาที
    if (notify && !input.notifyAt) await this.tick().catch((e) => this.log.error(String(e)));
    return { document: row };
  }

  /** ยกเลิกฉบับที่ตั้งเวลาไว้ (ยังไม่มีผลและยังไม่มีใครยอมรับ) · ฉบับที่มีผลแล้วลบไม่ได้ */
  async cancel(staff: Staff, id: string) {
    const { document: d } = await this.get(id);
    if (d.effectiveAt.getTime() <= Date.now()) throw new AppError(409, 'already_effective', 'ฉบับนี้มีผลแล้ว แก้หรือลบไม่ได้ · ออกเวอร์ชันใหม่แทน');
    const [{ n }] = await this.rows<{ n: number }>(sql`select count(*)::int as n from legal_acceptances where document_id = ${d.id}`);
    if (n > 0) throw new AppError(409, 'has_acceptances', 'มีผู้ยอมรับฉบับนี้แล้ว');
    await this.db.delete(s.legalDocuments).where(eq(s.legalDocuments.id, d.id));
    await staffAudit(this.db, staff, 'legal.version_cancelled', `${d.docType} v${d.version} (${d.locale})`, { type: 'legal_document', id: d.id });
    return { id: d.id, cancelled: true };
  }

  /** ประวัติการยอมรับ: ค้นด้วยอีเมลหรือ Workspace เพื่อใช้เป็นหลักฐาน */
  async acceptances(q: z.infer<typeof AcceptancesQuery>) {
    const parts: SQL[] = [sql`true`];
    if (q.q) parts.push(sql`(u.email ilike ${`%${q.q}%`} or w.name ilike ${`%${q.q}%`} or w.slug ilike ${`%${q.q}%`})`);
    if (q.docType) parts.push(sql`d.doc_type = ${q.docType}`);
    if (q.version) parts.push(sql`d.version = ${q.version}`);
    const items = await this.rows(sql`
      select a.id, a.accepted_at as "acceptedAt", u.email, u.display_name as "displayName", w.slug as workspace, w.name as "workspaceName",
        d.doc_type as "docType", d.version, d.locale, a.ip, case when a.workspace_id is null then 'signup' else 'in_app' end as channel
      from legal_acceptances a join users u on u.id = a.user_id join legal_documents d on d.id = a.document_id left join workspaces w on w.id = a.workspace_id
      where ${sql.join(parts, sql` and `)} order by a.accepted_at desc limit ${q.limit}`);
    return { items };
  }

  async acceptancesCsv(q: z.infer<typeof AcceptancesQuery>) {
    const { items } = await this.acceptances({ ...q, limit: Math.max(q.limit, 1000) });
    const esc = (v: unknown) => {
      const t = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const header = ['เวลา', 'อีเมล', 'ชื่อ', 'Workspace', 'เอกสาร', 'เวอร์ชัน', 'ภาษา', 'ช่องทาง', 'IP'];
    const lines = items.map((r) => [r.acceptedAt, r.email, r.displayName, r.workspace, r.docType, r.version, r.locale, r.channel, r.ip]);
    return '﻿' + [header, ...lines].map((l) => l.map(esc).join(',')).join('\r\n') + '\r\n';
  }
}
