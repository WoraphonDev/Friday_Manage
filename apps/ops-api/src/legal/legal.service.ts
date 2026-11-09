import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';

const s = schema;
const DAY = 86_400_000;
type Row = Record<string, unknown>;
/** ชนิดเอกสารเดียวกับ apps/api (public.service › LEGAL_TYPES) */
export const LEGAL_TYPES = ['terms', 'privacy', 'dpa', 'cookie', 'subprocessors'] as const;
/** เปลี่ยนสาระสำคัญต้องแจ้งล่วงหน้าอย่างน้อย 30 วัน (A7) */
export const NOTICE_DAYS = 30;

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
export class LegalService {
  constructor(@Inject(OPS_DB) private readonly db: Db) {}

  private async rows<T = Row>(q: SQL) {
    const r = await this.db.execute(q);
    return ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as T[];
  }

  /** ทุกชนิด: ฉบับที่ใช้อยู่ ฉบับที่ตั้งเวลาไว้ จำนวนผู้ยอมรับ และผู้ใช้ที่ยังต้องยอมรับ */
  async documents() {
    const docs = await this.rows<Row>(sql`
      select d.id, d.doc_type as "docType", d.version, d.locale, d.effective_at as "effectiveAt", d.summary, d.requires_acceptance as "requiresAcceptance",
        d.created_at as "createdAt", st.name as "createdBy",
        (select count(*)::int from legal_acceptances a where a.document_id = d.id) as accepted
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
    const [row] = await this.db
      .insert(s.legalDocuments)
      .values({ docType: input.docType, version: input.version, locale: input.locale, summary: input.summary, body: input.body, effectiveAt: effective, requiresAcceptance: input.requiresAcceptance, createdByStaff: staff.id })
      .returning();
    await staffAudit(this.db, staff, 'legal.version_scheduled', `${input.docType} v${input.version} (${input.locale}) มีผล ${effective.toISOString()} · ${input.requiresAcceptance ? 'ต้องยอมรับใหม่' : 'แจ้งให้ทราบ'} · ${input.summary}`, { type: 'legal_document', id: row.id });
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
