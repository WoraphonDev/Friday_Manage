import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, asc, desc, eq, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';

const s = schema;
const a = s.announcements;
const DAY = 86_400_000;

/** แบนเนอร์แสดงในแอปลูกค้านานเท่าไรหลังส่ง (ผู้ใช้ปิดเองได้ก่อน) */
export const BANNER_DAYS = 30;
/** ตั้งเวลาล่วงหน้าได้ไม่เกิน 1 ปี */
const MAX_SCHEDULE_DAYS = 365;
/** เหตุการณ์ของแจ้งเตือนที่ใช้ส่งอีเมลประกาศผ่านท่อส่งของ API ลูกค้า (apps/api/src/channels) */
export const ANNOUNCEMENT_EVENT = 'ops.announcement';
/** ตัวแปรในหัวข้อ / ข้อความ (C8: "ใส่ตัวแปร {ชื่อ Workspace} ได้") */
export const WS_VAR = '{ชื่อ Workspace}';
export const fill = (text: string, workspaceName: string) => text.replaceAll(WS_VAR, workspaceName);

const CHANNELS = ['email', 'banner'] as const;
const PLAN_CODES = ['free', 'team_s', 'team_m', 'team_l', 'enterprise'] as const;
const FEATURES = ['line', 'webhook', 'github', 'api_token', 'automation', 'import', 'no_project'] as const;
/** ส่งถึงเกินจำนวนนี้ต้องแตะ Security key (S8) */
export const REAUTH_OVER = 1000;
/** ท่อส่งของ API ลูกค้าส่งอีเมลชุดละประมาณ 50 ฉบับต่อนาที (ใช้ประมาณเวลาในหน้าส่ง) */
export const EMAIL_BATCH_PER_MINUTE = 50;
const WorkspaceIds = z.array(z.uuid()).min(1, 'เลือก Workspace อย่างน้อย 1 แห่ง').max(1000);
/**
 * ตัวกรองของหน้า Workspaces (ตรงกับ ListQuery ของ customers.service ยกเว้นการเรียง / หน้า) · strict กันส่งผิดกลุ่มเมื่อหน้าส่งค่าที่ไม่รู้จักมา
 * ไม่ระบุ status = ไม่รวม Workspace ที่ระงับ / รอลบ
 */
export const AnnouncementFilter = z
  .object({
    plan: z.enum(PLAN_CODES).optional(),
    status: z.enum(['trial', 'active', 'suspended', 'pending_delete', 'trialing', 'canceled', 'past_due']).optional(),
    q: z.string().trim().max(100).optional(),
    feature: z.enum(FEATURES).optional(),
  })
  .strict();
export type AnnouncementFilter = z.infer<typeof AnnouncementFilter>;
export const TARGET_MODES = ['selected', 'filter', 'all'] as const;
/** ผู้รับ (S8): ที่เลือกไว้ · ทุก Workspace ตามตัวกรอง (หาตอนส่ง) · ลูกค้าทุกรายที่ใช้งานอยู่ */
const Target = {
  targetMode: z.enum(TARGET_MODES).default('selected'),
  workspaceIds: WorkspaceIds.optional(),
  filter: AnnouncementFilter.optional(),
};
const targetCheck = (v: { targetMode: string; workspaceIds?: string[]; filter?: AnnouncementFilter }, ctx: z.RefinementCtx) => {
  if (v.targetMode === 'selected' && !v.workspaceIds?.length) ctx.addIssue({ code: 'custom', path: ['workspaceIds'], message: 'เลือก Workspace อย่างน้อย 1 แห่ง' });
  if (v.targetMode === 'filter' && !v.filter) ctx.addIssue({ code: 'custom', path: ['filter'], message: 'ไม่มีตัวกรองของหน้า Workspaces' });
};
export const AudienceBody = z.object(Target).strict().superRefine(targetCheck);
export const CreateBody = z
  .object({
    ...Target,
    title: z.string().trim().min(1, 'กรอกหัวข้อ').max(150),
    message: z.string().trim().min(1, 'กรอกข้อความ').max(2000),
    channels: z.array(z.enum(CHANNELS)).min(1, 'เลือกช่องทางอย่างน้อย 1 ช่องทาง'),
    /** ไม่ส่ง / null = ส่งตอนนี้ */
    scheduledAt: z.iso.datetime({ offset: true }).nullish(),
  })
  .strict()
  .superRefine(targetCheck);
export const TestBody = z.object({ title: z.string().trim().min(1).max(150), message: z.string().trim().min(1).max(2000), workspaceId: z.uuid().optional() }).strict();
export const CancelBody = z.object({ reason: z.string().trim().max(300).optional() }).strict();

/** ผู้เรียกภายใน (โปรโมชัน, สิทธิ์ตามแพ็กเกจ) ไม่ต้องระบุโหมด = ที่เลือกไว้ */
export type CreateInput = Omit<z.infer<typeof CreateBody>, 'targetMode'> & { targetMode?: (typeof TARGET_MODES)[number] };
type AnnouncementRow = typeof a.$inferSelect;
interface Recipient {
  workspaceId: string;
  userId: string;
  email: string;
}

const PLAN_NAMES: Record<string, string> = { free: 'Free', team_s: 'Team S', team_m: 'Team M', team_l: 'Team L', enterprise: 'Enterprise' };
/** ตัวกรองเป็นข้อความสั้น ๆ สำหรับ Audit */
const filterText = (f?: AnnouncementFilter) => {
  const parts = [f?.plan ? PLAN_NAMES[f.plan] : null, f?.status ?? null, f?.feature ?? null, f?.q ? `"${f.q}"` : null].filter(Boolean);
  return parts.length ? ` (${parts.join(', ')})` : '';
};

/** หัวเรื่องอีเมลแบบเดียวกับที่ API ลูกค้าส่งจริง (renderEmail ใน apps/api/src/channels/render.ts) */
const subjectOf = (title: string) => `[Friday] ประกาศจากทีม Friday: ${title}`;

/**
 * ประกาศถึงลูกค้าที่เลือก (O24 · Canvas › C8)
 * - ส่งถึง Owner / Admin ที่ใช้งานอยู่ของ Workspace ที่เลือก · ช่องทาง อีเมล / แบนเนอร์ในแอป / ทั้งสอง · ส่งตอนนี้หรือตั้งเวลา
 * - อีเมล: สร้างแจ้งเตือน (in_app = false ไม่ขึ้น Inbox) + รายการส่งใน notification_deliveries ให้ API ลูกค้าส่งผ่านท่อเดิม
 *   จึงอยู่ในประวัติการส่ง (O23) · อีเมลในรายชื่อไม่ส่งบันทึกเป็น suppressed ตั้งแต่ตอนนี้และไม่ถูกส่ง
 * - แบนเนอร์: เขียนข้อความที่แทนตัวแปรแล้วลง announcement_targets ให้ API ลูกค้าอ่านผ่าน RLS
 * - เฉพาะ Owner ของทีม Friday · Audit log ของทุก Workspace ที่ได้รับ + Audit ของทีม
 */
@Injectable()
export class AnnouncementsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Announcements');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly mail: Mailer,
  ) {}

  onModuleInit() {
    // ส่งประกาศที่ถึงเวลา ทุกนาที · test เรียก tick() เอง · ปิดด้วย OPS_JOBS=off
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      this.timer = setInterval(() => void this.tick().catch((e) => this.log.error(String(e))), 60_000);
      this.timer.unref?.();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** ส่งประกาศที่ตั้งเวลาไว้และถึงเวลาแล้ว */
  async tick(now = new Date()) {
    const due = await this.db
      .select({ id: a.id })
      .from(a)
      // ตามตัวกรอง / ทุกราย ยังไม่มีแถวผู้รับจนถึงเวลาส่ง
      .where(and(lte(a.scheduledAt, now), isNull(a.sentAt), isNull(a.cancelledAt), sql`(${a.targetMode} <> 'selected' or exists (select 1 from announcement_targets t where t.announcement_id = ${a.id}))`))
      .orderBy(asc(a.scheduledAt))
      .limit(50);
    let sent = 0;
    for (const r of due) {
      const res = await this.send(r.id, now);
      if (res) {
        sent++;
        await staffAudit(this.db, null, 'ops.announcement_sent', `ส่งประกาศที่ตั้งเวลาไว้ถึง ${res.workspaces} Workspace (${res.recipients} คน)`, { type: 'announcement', id: r.id });
      }
    }
    return { sent };
  }

  // ---------------------------------------------------------------------------
  // ผู้รับ
  // ---------------------------------------------------------------------------

  /** Workspace ที่ยังไม่ถูกลบ · ส่งรหัสที่ไม่พบ = 404 ทั้งคำขอ (กันส่งผิดกลุ่ม) */
  private async workspaces(db: Db | Tx, ids: string[]) {
    const unique = [...new Set(ids)];
    const rows = await db
      .select({ id: s.workspaces.id, name: s.workspaces.name, slug: s.workspaces.slug })
      .from(s.workspaces)
      .where(and(inArray(s.workspaces.id, unique), isNull(s.workspaces.deletedAt)));
    if (rows.length !== unique.length) throw new AppError(404, 'workspace_not_found', 'ไม่พบ Workspace บางแห่ง (อาจถูกลบไปแล้ว) · โหลดรายการใหม่แล้วเลือกอีกครั้ง', { missing: unique.filter((id) => !rows.some((r) => r.id === id)) });
    return rows;
  }

  /**
   * หา Workspace ตามโหมดผู้รับ ณ ตอนนี้ (S8) · ตามตัวกรองใช้เงื่อนไขเดียวกับหน้า Workspaces
   * ทุกราย = ลูกค้าที่ใช้งานอยู่ (ทดลองใช้ / ใช้งาน) · ตามตัวกรองที่ไม่ระบุสถานะก็ไม่รวมที่ระงับ / รอลบ
   */
  async resolve(db: Db | Tx, mode: 'filter' | 'all', filter: AnnouncementFilter | null) {
    const parts: SQL[] = [sql`w.deleted_at is null`];
    const f = mode === 'filter' ? (filter ?? {}) : {};
    if (!f.status) parts.push(sql`w.status not in ('suspended', 'pending_delete')`);
    else parts.push(['trialing', 'canceled', 'past_due'].includes(f.status) ? sql`sub.status = ${f.status}` : sql`w.status = ${f.status}`);
    if (f.q) parts.push(sql`(w.name ilike ${`%${f.q}%`} or w.slug ilike ${`%${f.q}%`})`);
    if (f.plan) parts.push(sql`p.code = ${f.plan}`);
    const feature: Record<(typeof FEATURES)[number], SQL> = {
      line: sql`exists(select 1 from line_oa_configs x where x.workspace_id = w.id)`,
      webhook: sql`exists(select 1 from webhook_endpoints x where x.workspace_id = w.id and x.status = 'active')`,
      github: sql`exists(select 1 from git_installations x where x.workspace_id = w.id and x.status = 'active')`,
      api_token: sql`exists(select 1 from api_tokens x where x.workspace_id = w.id and x.revoked_at is null)`,
      automation: sql`exists(select 1 from automation_rules x where x.workspace_id = w.id and x.enabled)`,
      import: sql`exists(select 1 from import_jobs x where x.workspace_id = w.id)`,
      no_project: sql`not exists(select 1 from projects x where x.workspace_id = w.id and x.deleted_at is null)`,
    };
    if (f.feature) parts.push(feature[f.feature]);
    const r = await db.execute(sql`
      select w.id, w.name, w.slug from workspaces w left join subscriptions sub on sub.workspace_id = w.id left join plans p on p.id = sub.plan_id
      where ${sql.join(parts, sql` and `)} order by w.name`);
    return ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as { id: string; name: string; slug: string }[];
  }

  /** Workspace ผู้รับตามคำขอ (ใช้ทั้งนับก่อนส่งและตอนสร้าง) */
  private async targetsOf(db: Db | Tx, input: { targetMode: (typeof TARGET_MODES)[number]; workspaceIds?: string[]; filter?: AnnouncementFilter }) {
    return input.targetMode === 'selected' ? this.workspaces(db, input.workspaceIds ?? []) : this.resolve(db, input.targetMode, input.filter ?? null);
  }

  /** Owner / Admin ที่ใช้งานอยู่ (บัญชีไม่ถูกปิด) */
  private async recipients(db: Db | Tx, workspaceIds: string[]): Promise<Recipient[]> {
    if (!workspaceIds.length) return [];
    return db
      .select({ workspaceId: s.workspaceMembers.workspaceId, userId: s.users.id, email: s.users.email })
      .from(s.workspaceMembers)
      .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
      .where(and(inArray(s.workspaceMembers.workspaceId, workspaceIds), eq(s.workspaceMembers.status, 'active'), inArray(s.workspaceMembers.role, ['owner', 'admin']), isNull(s.users.disabledAt)));
  }

  /** อีเมลที่อยู่ในรายชื่อไม่ส่ง (O23) → เหตุผล */
  private async suppressed(db: Db | Tx, emails: string[]) {
    if (!emails.length) return new Map<string, string>();
    const lower = [...new Set(emails.map((e) => e.toLowerCase()))];
    const rows = await db
      .select({ email: s.emailSuppressions.email, reason: s.emailSuppressions.reason })
      .from(s.emailSuppressions)
      .where(and(sql`lower(${s.emailSuppressions.email}) = any(${sql.param(lower)}::text[])`, isNull(s.emailSuppressions.removedAt)));
    return new Map(rows.map((r) => [r.email.toLowerCase(), r.reason]));
  }

  /** จำนวนผู้รับก่อนส่ง (C8: "Owner และ Admin รวม N คน") · คนเดียวเป็น Admin หลาย Workspace นับครั้งเดียว */
  async audience(input: z.infer<typeof AudienceBody>) {
    const ws = await this.targetsOf(this.db, input);
    const people = await this.recipients(this.db, ws.map((w) => w.id));
    const sup = await this.suppressed(this.db, people.map((p) => p.email));
    const users = new Set(people.map((p) => p.userId));
    const blocked = new Set(people.filter((p) => sup.has(p.email.toLowerCase())).map((p) => p.userId));
    return {
      workspaces: ws.length,
      people: users.size,
      /** อีเมลที่จะส่งจริง (1 ฉบับต่อคนต่อ Workspace เพราะแทนชื่อ Workspace ต่างกัน) */
      emails: people.filter((p) => !sup.has(p.email.toLowerCase())).length,
      suppressed: blocked.size,
      noRecipients: ws.filter((w) => !people.some((p) => p.workspaceId === w.id)).slice(0, 50).map((w) => ({ id: w.id, name: w.name })),
      /** S8: ส่งชุดละ 50 ฉบับต่อนาที · เกิน 1,000 Workspace ต้องแตะกุญแจ */
      minutes: Math.ceil(people.filter((p) => !sup.has(p.email.toLowerCase())).length / EMAIL_BATCH_PER_MINUTE),
      needsReauth: ws.length > REAUTH_OVER,
    };
  }

  // ---------------------------------------------------------------------------
  // สร้าง / ส่ง / ยกเลิก
  // ---------------------------------------------------------------------------

  async create(staff: Staff, body: CreateInput, now = new Date(), reauthed = false) {
    const input = { ...body, targetMode: body.targetMode ?? 'selected' };
    const channels = CHANNELS.filter((c) => input.channels.includes(c));
    const at = input.scheduledAt ? new Date(input.scheduledAt) : null;
    if (at && at.getTime() <= now.getTime() + 60_000) throw new AppError(422, 'scheduled_in_past', 'เวลาส่งต้องอยู่ในอนาคต (อย่างน้อย 1 นาทีจากตอนนี้) · ถ้าต้องการส่งทันทีให้เลือก "ตอนนี้"');
    if (at && at.getTime() > now.getTime() + MAX_SCHEDULE_DAYS * DAY) throw new AppError(422, 'scheduled_too_far', `ตั้งเวลาล่วงหน้าได้ไม่เกิน ${MAX_SCHEDULE_DAYS} วัน`);
    const id = await this.db.transaction(async (tx) => {
      const ws = await this.targetsOf(tx, input);
      if (!ws.length) throw new AppError(422, 'no_workspaces', 'ไม่มี Workspace ตรงกับผู้รับที่เลือก');
      if (ws.length > REAUTH_OVER && !reauthed) throw new AppError(401, 'reauth_required', `ส่งถึงเกิน ${REAUTH_OVER.toLocaleString('en-US')} Workspace · ยืนยันตัวตนอีกครั้ง (รหัส 6 หลักหรือ Security key)`);
      const selected = input.targetMode === 'selected';
      const [row] = await tx
        .insert(a)
        // ส่งตอนนี้ก็ตั้ง scheduled_at = ตอนนี้ไว้ด้วย: ถ้าส่งทันทีไม่สำเร็จ tick รอบถัดไปส่งให้
        .values({ title: input.title, message: input.message, audience: 'owners_admins', channels: [...channels], scheduledAt: at ?? now, createdBy: staff.id, targetMode: input.targetMode, targetFilter: input.targetMode === 'filter' ? (input.filter ?? {}) : null })
        .returning({ id: a.id });
      const how = channels.map((c) => (c === 'email' ? 'อีเมล' : 'แบนเนอร์ในแอป')).join(' + ');
      const when = at ? `ตั้งเวลาส่ง ${at.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' })}` : 'ส่งทันที';
      // ตามตัวกรอง / ทุกราย: รายชื่อหาใหม่ตอนส่ง จึงเขียนผู้รับและ Audit log ของลูกค้าใน send()
      if (selected) {
        await tx.insert(s.announcementTargets).values(ws.map((w) => ({ announcementId: row.id, workspaceId: w.id })));
        await this.customerAudit(tx, staff, row.id, input.title, ws, `${how} · ${when}`);
      }
      const who = selected ? `${ws.length} Workspace` : input.targetMode === 'all' ? `ลูกค้าทุกราย (ตอนนี้ ${ws.length} Workspace)` : `ทุก Workspace ตามตัวกรอง${filterText(input.filter)} (ตอนนี้ ${ws.length} Workspace)`;
      await staffAudit(tx, staff, 'ops.announcement', `ประกาศ "${input.title}" ถึง ${who} · ${how} · ${when}`, { type: 'announcement', id: row.id });
      return row.id;
    });
    if (!at) await this.send(id, now);
    return this.one(id);
  }

  /** ลูกค้าเห็นในหน้า Audit log ของตัวเองว่าทีม Friday ส่งอะไรถึง Owner / Admin · staff ว่าง = ระบบส่งตามที่ตั้งไว้ */
  private async customerAudit(tx: Tx, staff: { id: string; name: string } | null, id: string, title: string, ws: { id: string; name: string }[], how: string) {
    if (!ws.length) return;
    await tx.insert(s.auditLogs).values(
      ws.map((w) => ({
        workspaceId: w.id,
        actorId: staff?.id ?? null,
        actorKind: 'friday_staff' as const,
        category: 'notify' as const,
        action: 'ops.announcement',
        targetType: 'announcement',
        targetId: id,
        summary: `[Friday${staff ? ` ${staff.name}` : ''}] ประกาศ "${fill(title, w.name)}" ถึง Owner / Admin · ${how}`,
      })),
    );
  }

  /**
   * ส่งจริง (ตอนนี้ หรือ tick เมื่อถึงเวลา) · จองแถวด้วย sent_at ก่อน กันส่งซ้ำเมื่อหลาย instance ทำงานพร้อมกัน
   * คืน null เมื่อส่งไปแล้ว / ถูกยกเลิก
   */
  async send(id: string, now = new Date()) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(a).set({ sentAt: now }).where(and(eq(a.id, id), isNull(a.sentAt), isNull(a.cancelledAt))).returning();
      if (!row) return null;
      if (row.targetMode !== 'selected') {
        // S8: หารายชื่อ ณ เวลาส่ง (ประกาศตั้งเวลาก็หาตอนถึงเวลา)
        const ws = await this.resolve(tx, row.targetMode as 'filter' | 'all', (row.targetFilter as AnnouncementFilter | null) ?? null);
        if (ws.length) {
          await tx.insert(s.announcementTargets).values(ws.map((w) => ({ announcementId: id, workspaceId: w.id }))).onConflictDoNothing();
          const [by] = row.createdBy ? await tx.select({ id: s.staffUsers.id, name: s.staffUsers.name }).from(s.staffUsers).where(eq(s.staffUsers.id, row.createdBy)) : [];
          const how = row.channels.map((c) => (c === 'email' ? 'อีเมล' : 'แบนเนอร์ในแอป')).join(' + ');
          await this.customerAudit(tx, by ?? null, id, row.title ?? row.message.slice(0, 80), ws, `${how} · ${row.targetMode === 'all' ? 'ประกาศถึงลูกค้าทุกราย' : 'ประกาศตามกลุ่มลูกค้า'}`);
        }
      }
      const targets = await tx
        .select({ id: s.workspaces.id, name: s.workspaces.name, deletedAt: s.workspaces.deletedAt })
        .from(s.announcementTargets)
        .innerJoin(s.workspaces, eq(s.workspaces.id, s.announcementTargets.workspaceId))
        .where(eq(s.announcementTargets.announcementId, id));
      // Workspace ที่ถูกลบระหว่างรอเวลาส่งไม่ได้รับ
      const live = targets.filter((t) => !t.deletedAt);
      const people = await this.recipients(tx, live.map((t) => t.id));
      const email = row.channels.includes('email');
      const banner = row.channels.includes('banner');
      const sup = email ? await this.suppressed(tx, people.map((p) => p.email)) : new Map<string, string>();
      const title = row.title ?? row.message.slice(0, 80);
      for (const t of live) {
        const mine = people.filter((p) => p.workspaceId === t.id);
        await tx
          .update(s.announcementTargets)
          .set({
            recipients: mine.length,
            ...(banner ? { bannerTitle: fill(title, t.name), bannerMessage: fill(row.message, t.name), bannerFrom: now, bannerUntil: new Date(now.getTime() + BANNER_DAYS * DAY) } : {}),
          })
          .where(and(eq(s.announcementTargets.announcementId, id), eq(s.announcementTargets.workspaceId, t.id)));
        if (email && mine.length) await this.queueEmails(tx, row, t, mine, sup, now);
      }
      return { id, workspaces: live.length, recipients: people.length };
    });
  }

  /**
   * อีเมล 1 ฉบับต่อคนต่อ Workspace: แจ้งเตือน (in_app = false) + รายการส่งที่ตั้ง resend_requested_at
   * งาน scan ของ API ลูกค้าหยิบรายการที่ทีม Friday ขอให้ส่งภายใน 1 นาที (ช่องทางเดียวกับปุ่มส่งซ้ำของ O23) แล้วส่งตาม pref / ช่วงงดส่งของผู้รับ
   */
  private async queueEmails(tx: Tx, row: AnnouncementRow, ws: { id: string; name: string }, people: Recipient[], sup: Map<string, string>, now: Date) {
    const title = fill(row.title ?? row.message.slice(0, 80), ws.name);
    const text = fill(row.message, ws.name);
    const notes = await tx
      .insert(s.notifications)
      .values(
        people.map((p) => ({
          workspaceId: ws.id,
          recipientId: p.userId,
          eventType: ANNOUNCEMENT_EVENT,
          payload: { announcementId: row.id, title, text },
          reason: `คุณเป็น Owner / Admin ของ Workspace ${ws.name}`,
          // ประกาศแสดงเป็นแบนเนอร์ (ถ้าเลือก) ไม่ใช่รายการใน Inbox
          inApp: false,
        })),
      )
      .returning({ id: s.notifications.id, recipientId: s.notifications.recipientId });
    await tx.insert(s.notificationDeliveries).values(
      people.map((p) => {
        const reason = sup.get(p.email.toLowerCase());
        return {
          workspaceId: ws.id,
          notificationId: notes.find((n) => n.recipientId === p.userId)!.id,
          channel: 'email' as const,
          targetRef: p.email,
          targetLabel: p.email,
          status: reason ? ('suppressed' as const) : ('queued' as const),
          lastError: reason ? `อีเมลอยู่ในรายชื่อไม่ส่ง (${reason})` : null,
          log: reason ? [{ at: now.toISOString(), kind: 'suppressed', message: reason, final: true }] : [],
          resendRequestedAt: reason ? null : now,
        };
      }),
    );
  }

  /**
   * ยกเลิก: ก่อนส่ง = ไม่ส่งเลย · หลังส่งที่มีแบนเนอร์ = หยุดแสดงแบนเนอร์ทันที (อีเมลที่ส่งไปแล้วเรียกคืนไม่ได้)
   */
  async cancel(staff: Staff, id: string, input: z.infer<typeof CancelBody>, now = new Date()) {
    const cur = await this.load(id);
    if (cur.cancelledAt) throw new AppError(409, 'announcement_cancelled', 'ประกาศนี้ถูกยกเลิกไปแล้ว');
    if (cur.sentAt && !cur.channels.includes('banner')) throw new AppError(409, 'announcement_sent', 'ส่งอีเมลไปแล้ว ยกเลิกไม่ได้');
    await this.db.transaction(async (tx) => {
      const [u] = await tx.update(a).set({ cancelledAt: now, cancelledBy: staff.id }).where(and(eq(a.id, id), isNull(a.cancelledAt))).returning({ sentAt: a.sentAt });
      if (!u) throw new AppError(409, 'announcement_cancelled', 'ประกาศนี้ถูกยกเลิกไปแล้ว');
      if (u.sentAt) await tx.update(s.announcementTargets).set({ bannerUntil: now }).where(and(eq(s.announcementTargets.announcementId, id), sql`${s.announcementTargets.bannerUntil} > ${now}`));
      const what = u.sentAt ? 'หยุดแสดงแบนเนอร์ประกาศ' : 'ยกเลิกประกาศที่ตั้งเวลาไว้';
      const targets = await tx
        .select({ id: s.workspaces.id, name: s.workspaces.name })
        .from(s.announcementTargets)
        .innerJoin(s.workspaces, eq(s.workspaces.id, s.announcementTargets.workspaceId))
        .where(eq(s.announcementTargets.announcementId, id));
      if (targets.length)
        await tx.insert(s.auditLogs).values(
          targets.map((w) => ({
            workspaceId: w.id,
            actorId: staff.id,
            actorKind: 'friday_staff' as const,
            category: 'notify' as const,
            action: 'ops.announcement_cancelled',
            targetType: 'announcement',
            targetId: id,
            summary: `[Friday ${staff.name}] ${what} "${fill(cur.title ?? cur.message.slice(0, 80), w.name)}"${input.reason ? ` · ${input.reason}` : ''}`,
          })),
        );
      await staffAudit(tx, staff, 'ops.announcement_cancelled', `${what} "${cur.title ?? cur.message.slice(0, 80)}"${input.reason ? ` · ${input.reason}` : ''}`, { type: 'announcement', id });
    });
    return this.one(id);
  }

  /** ส่งทดสอบถึงอีเมลของพนักงานเอง (C8: "ส่งทดสอบถึงฉัน") · ไม่บันทึกเป็นการส่งถึงลูกค้า */
  async test(staff: Staff, input: z.infer<typeof TestBody>) {
    const [ws] = input.workspaceId ? await this.db.select({ name: s.workspaces.name }).from(s.workspaces).where(eq(s.workspaces.id, input.workspaceId)) : [];
    const name = ws?.name ?? 'Workspace ตัวอย่าง';
    const title = fill(input.title, name);
    await this.mail.send({
      to: staff.email,
      subject: `[ทดสอบ] ${subjectOf(title)}`,
      text: [`ประกาศจากทีม Friday: ${title}`, '', fill(input.message, name), '', `(อีเมลทดสอบ · ตัวแปรแทนด้วย "${name}" · ลูกค้ายังไม่ได้รับ)`].join('\n'),
    });
    return { to: staff.email };
  }

  // ---------------------------------------------------------------------------
  // อ่าน
  // ---------------------------------------------------------------------------

  private async load(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบประกาศ');
    const [row] = await this.db.select().from(a).where(eq(a.id, id));
    if (!row) throw new AppError(404, 'not_found', 'ไม่พบประกาศ');
    return row;
  }

  async one(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบประกาศ');
    const [item] = await this.items([id]);
    if (!item) throw new AppError(404, 'not_found', 'ไม่พบประกาศ');
    return item;
  }

  /** ประวัติประกาศ ล่าสุดก่อน · สรุปผลการส่งอีเมลจากประวัติการส่ง (เก็บ 90 วัน) */
  async list() {
    return { items: await this.items(), bannerDays: BANNER_DAYS };
  }

  private async items(ids?: string[]) {
    const rows = await this.db
      .select({ a, by: s.staffUsers.name })
      .from(a)
      .leftJoin(s.staffUsers, eq(s.staffUsers.id, a.createdBy))
      .where(ids ? inArray(a.id, ids) : undefined)
      .orderBy(desc(a.createdAt), desc(a.id))
      .limit(200);
    if (!rows.length) return [];
    const list = rows.map((r) => r.a.id);
    const targets = await this.db
      .select({ announcementId: s.announcementTargets.announcementId, id: s.workspaces.id, name: s.workspaces.name, recipients: s.announcementTargets.recipients })
      .from(s.announcementTargets)
      .innerJoin(s.workspaces, eq(s.workspaces.id, s.announcementTargets.workspaceId))
      .where(inArray(s.announcementTargets.announcementId, list))
      .orderBy(asc(s.workspaces.name));
    const stats = (
      await this.db.execute(sql`
        select n.payload->>'announcementId' as id,
          count(*)::int as total,
          count(*) filter (where d.status = 'sent')::int as sent,
          count(*) filter (where d.status = 'suppressed')::int as suppressed,
          count(*) filter (where d.status = 'failed')::int as failed,
          count(*) filter (where d.status in ('queued', 'skipped_quiet_hours'))::int as waiting
        from notification_deliveries d join notifications n on n.id = d.notification_id
        where n.event_type = ${ANNOUNCEMENT_EVENT} and n.payload->>'announcementId' = any(${sql.param(list)}::text[])
        group by 1`)
    ).rows as { id: string; total: number; sent: number; suppressed: number; failed: number; waiting: number }[];
    return rows.map(({ a: x, by }) => {
      const mine = targets.filter((t) => t.announcementId === x.id);
      const st = stats.find((r) => r.id === x.id);
      return {
        id: x.id,
        title: x.title,
        message: x.message,
        channels: x.channels,
        status: x.cancelledAt ? (x.sentAt ? 'stopped' : 'cancelled') : x.sentAt ? 'sent' : x.scheduledAt ? 'scheduled' : 'draft',
        scheduledAt: x.scheduledAt,
        sentAt: x.sentAt,
        cancelledAt: x.cancelledAt,
        createdAt: x.createdAt,
        createdBy: by,
        workspaces: { count: mine.length, names: mine.slice(0, 3).map((t) => t.name), ids: mine.map((t) => t.id) },
        /** S8: ตามตัวกรอง / ทุกราย ยังไม่มีรายชื่อจนกว่าจะส่ง · หลังส่ง workspaces.count = จำนวนจริงที่ส่ง */
        target: { mode: x.targetMode, filter: x.targetFilter },
        recipients: x.sentAt ? mine.reduce((n, t) => n + (t.recipients ?? 0), 0) : null,
        email: st ? { total: st.total, sent: st.sent, suppressed: st.suppressed, failed: st.failed, waiting: st.waiting } : null,
        canCancel: !x.cancelledAt && (!x.sentAt || x.channels.includes('banner')),
      };
    });
  }
}
