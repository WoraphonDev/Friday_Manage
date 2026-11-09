import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { config } from '../config.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';

const s = schema;
type Row = Record<string, unknown>;

export const UsersQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'locked', 'unverified', 'disabled']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
/** ทุกการกระทำกับบัญชีผู้ใช้ต้องผูกกับ Ticket และมีเหตุผล */
const Base = { ticketNo: z.string().trim().min(3).max(40), reason: z.string().trim().min(3).max(500) };
export const ActionBody = z.object(Base).strict();
/** หลักฐานยืนยันว่าเป็นเจ้าของบัญชีจริง อย่างน้อย 2 ข้อ (C10) */
const Proofs = z
  .array(z.enum(['email_reply', 'workspace_owner', 'video_call']))
  .refine((a) => new Set(a).size >= 2, 'ยืนยันตัวตนเจ้าของบัญชีอย่างน้อย 2 ข้อ');
export const ResetMfaBody = z.object({ ...Base, proofs: Proofs }).strict();
export const ChangeEmailBody = z.object({ ...Base, newEmail: z.email().trim().toLowerCase().max(254), proofs: Proofs }).strict();
export const CloseBody = z.object({ ...Base, confirmEmail: z.string().trim().toLowerCase() }).strict();

const PROOF_LABEL: Record<string, string> = { email_reply: 'ตอบจากอีเมลของบัญชีใน Ticket', workspace_owner: 'Owner ของ Workspace ยืนยัน', video_call: 'วิดีโอคอลพร้อมบัตร' };
/** อายุลิงก์ (นาที) ให้เท่ากับฝั่ง API ลูกค้าโดยประมาณ */
const LINK_MINUTES = { verify_email: 24 * 60, change_email: 60 } as const;

/**
 * ผู้ใช้ทั้งระบบ (O02 · หน้า "ผู้ใช้ทั้งหมด" และ C10) · ข้าม Workspace จึงใช้ OPS_DB
 * ทุกการกระทำ: แจ้งผู้ใช้ทางอีเมล, เขียน audit_logs ของทุก Workspace ที่ผู้ใช้เป็นสมาชิก (ลูกค้าเห็น) และ staff_audit_logs
 */
@Injectable()
export class UsersService {
  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly mail: Mailer,
  ) {}

  private async rows<T = Row>(q: SQL) {
    const r = await this.db.execute(q);
    return ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as T[];
  }

  private static status = sql`case when u.disabled_at is not null then 'disabled' when u.locked_until > now() then 'locked' when u.email_verified_at is null then 'unverified' else 'active' end`;

  async list(q: z.infer<typeof UsersQuery>) {
    const parts: SQL[] = [sql`true`];
    if (q.q) parts.push(sql`(u.email ilike ${`%${q.q}%`} or u.display_name ilike ${`%${q.q}%`})`);
    if (q.status) parts.push(sql`${UsersService.status} = ${q.status}`);
    const where = sql.join(parts, sql` and `);
    const items = await this.rows(sql`
      select u.id, u.email, u.display_name as "displayName", u.locale, u.year_format as "yearFormat", u.timezone, u.created_at as "createdAt",
        ${UsersService.status} as status,
        (u.password_hash is not null) as "hasPassword",
        coalesce((select array_agg(distinct i.provider::text) from user_identities i where i.user_id = u.id), '{}') as providers,
        exists(select 1 from mfa_factors f where f.user_id = u.id and f.enabled_at is not null) as "mfaEnabled",
        exists(select 1 from line_bindings l where l.user_id = u.id and l.unbound_at is null) as "lineBound",
        (select count(*)::int from workspace_members m where m.user_id = u.id and m.status = 'active') as workspaces,
        (select w.name from workspace_members m join workspaces w on w.id = m.workspace_id where m.user_id = u.id and m.status = 'active' order by m.joined_at limit 1) as "firstWorkspace",
        (select max(x.last_seen_at) from user_sessions x where x.user_id = u.id) as "lastSeenAt"
      from users u where ${where}
      order by u.created_at desc limit ${q.limit} offset ${q.offset}`);
    const [{ total }] = await this.rows<{ total: number }>(sql`select count(*)::int as total from users u where ${where}`);
    return { items: items.map(({ hasPassword, providers, ...r }) => ({ ...r, login: [...(hasPassword ? ['password'] : []), ...(providers as string[])] })), total, limit: q.limit, offset: q.offset };
  }

  private async find(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบผู้ใช้');
    const [u] = await this.db.select().from(s.users).where(eq(s.users.id, id));
    if (!u) throw new AppError(404, 'not_found', 'ไม่พบผู้ใช้');
    return u;
  }

  async get(id: string) {
    const u = await this.find(id);
    const [extra] = await this.rows(sql`
      select ${UsersService.status} as status,
        coalesce((select array_agg(distinct i.provider::text) from user_identities i where i.user_id = u.id), '{}') as providers,
        exists(select 1 from mfa_factors f where f.user_id = u.id and f.enabled_at is not null) as "mfaEnabled",
        (select l.line_display_name from line_bindings l where l.user_id = u.id and l.unbound_at is null) as "lineName"
      from users u where u.id = ${id}`);
    const memberships = await this.rows(sql`
      select w.id, w.slug, w.name, m.role, m.status, m.joined_at as "joinedAt", m.last_active_at as "lastActiveAt"
      from workspace_members m join workspaces w on w.id = m.workspace_id where m.user_id = ${id} order by m.joined_at`);
    const sessions = await this.rows(sql`
      select id, device_name as "deviceName", user_agent as "userAgent", ip, location, last_seen_at as "lastSeenAt", created_at as "createdAt"
      from user_sessions where user_id = ${id} and revoked_at is null order by last_seen_at desc limit 20`);
    const tickets = await this.rows(sql`
      select id, number, subject, status, created_at as "createdAt" from support_tickets
      where requester_user_id = ${id} or lower(requester_email) = lower(${u.email}) order by created_at desc limit 20`);
    return {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      emailVerifiedAt: u.emailVerifiedAt,
      locale: u.locale,
      yearFormat: u.yearFormat,
      timezone: u.timezone,
      createdAt: u.createdAt,
      lockedUntil: u.lockedUntil,
      failedLoginCount: u.failedLoginCount,
      disabledAt: u.disabledAt,
      status: extra.status,
      login: [...(u.passwordHash ? ['password'] : []), ...(extra.providers as string[])],
      mfaEnabled: extra.mfaEnabled,
      line: extra.lineName === undefined || extra.lineName === null ? null : { displayName: extra.lineName },
      memberships,
      sessions,
      tickets,
    };
  }

  /** รอยการกระทำ: audit_logs ของทุก Workspace ที่ผู้ใช้เป็นสมาชิก (ลูกค้าเห็น) + staff_audit_logs 1 แถว */
  private async trace(tx: Db | Tx, staff: Staff, userId: string, action: string, summary: string) {
    const ws = await tx.select({ id: s.workspaceMembers.workspaceId }).from(s.workspaceMembers).where(eq(s.workspaceMembers.userId, userId));
    for (const w of ws) {
      await tx.insert(s.auditLogs).values({ workspaceId: w.id, actorId: staff.id, actorKind: 'friday_staff', category: 'secu', action, targetType: 'user', targetId: userId, summary: `[Friday ${staff.name}] ${summary}` });
    }
    await staffAudit(tx, staff, action, summary, { type: 'user', id: userId });
  }

  private async notify(to: string, subject: string, lines: string[]) {
    try {
      await this.mail.send({ to, subject, text: [...lines, '', 'ถ้าคุณไม่ได้ติดต่อทีม Friday เรื่องนี้ ตอบกลับอีเมลนี้ทันที'].join('\n') });
      return true;
    } catch {
      return false;
    }
  }

  /** ลิงก์ใช้ครั้งเดียวแบบเดียวกับ API ลูกค้า (sha256 ของ token) · ยกเลิกลิงก์เดิมของเรื่องเดียวกันที่ยังไม่ใช้ */
  private async issueLink(tx: Db | Tx, userId: string, purpose: keyof typeof LINK_MINUTES, newEmail?: string) {
    const token = randomBytes(32).toString('base64url');
    await tx.update(s.authTokens).set({ usedAt: new Date() }).where(and(eq(s.authTokens.userId, userId), eq(s.authTokens.purpose, purpose), isNull(s.authTokens.usedAt)));
    await tx.insert(s.authTokens).values({ userId, purpose, tokenHash: createHash('sha256').update(token).digest('hex'), newEmail, expiresAt: new Date(Date.now() + LINK_MINUTES[purpose] * 60_000) });
    return `${config.appUrl}/signup?token=${encodeURIComponent(token)}`;
  }

  async unlock(staff: Staff, id: string, input: z.infer<typeof ActionBody>) {
    const u = await this.find(id);
    if (!u.lockedUntil || u.lockedUntil.getTime() <= Date.now()) throw new AppError(409, 'not_locked', 'บัญชีนี้ไม่ได้ถูกล็อก');
    await this.db.transaction(async (tx) => {
      await tx.update(s.users).set({ lockedUntil: null, failedLoginCount: 0, updatedAt: new Date() }).where(eq(s.users.id, id));
      await this.trace(tx, staff, id, 'ops.user_unlocked', `ปลดล็อกบัญชี ${u.email} · Ticket ${input.ticketNo} · ${input.reason}`);
    });
    await this.notify(u.email, 'บัญชี Friday Manage ของคุณถูกปลดล็อกแล้ว', [`ทีม Friday ปลดล็อกบัญชีตามคำขอใน Ticket ${input.ticketNo} · เข้าสู่ระบบได้ตามปกติ`]);
    return { id, status: 'unlocked' as const };
  }

  async resendVerification(staff: Staff, id: string, input: z.infer<typeof ActionBody>) {
    const u = await this.find(id);
    if (u.emailVerifiedAt) throw new AppError(409, 'already_verified', 'ยืนยันอีเมลแล้ว');
    const link = await this.db.transaction(async (tx) => {
      const l = await this.issueLink(tx, id, 'verify_email');
      await this.trace(tx, staff, id, 'ops.verification_resent', `ส่งอีเมลยืนยันอีกครั้งถึง ${u.email} · Ticket ${input.ticketNo} · ${input.reason}`);
      return l;
    });
    const sent = await this.notify(u.email, 'ยืนยันอีเมลของคุณ · Friday Manage', [`กดลิงก์นี้เพื่อยืนยันอีเมล: ${link}`, `ลิงก์ใช้ได้ ${LINK_MINUTES.verify_email / 60} ชั่วโมง`]);
    return { id, sent };
  }

  /** รีเซ็ต 2FA (C10): ลบปัจจัยเดิม ผู้ใช้ต้องตั้งใหม่ตอนล็อกอินครั้งถัดไป · บันทึกหลักฐานยืนยันตัวตนใน Audit */
  async resetMfa(staff: Staff, id: string, input: z.infer<typeof ResetMfaBody>) {
    const u = await this.find(id);
    const [factor] = await this.db.select({ id: s.mfaFactors.id }).from(s.mfaFactors).where(eq(s.mfaFactors.userId, id));
    if (!factor) throw new AppError(409, 'mfa_not_enabled', 'ผู้ใช้นี้ยังไม่ได้ตั้ง 2FA');
    const proofs = [...new Set(input.proofs)].map((p) => PROOF_LABEL[p]).join(', ');
    await this.db.transaction(async (tx) => {
      await tx.delete(s.mfaFactors).where(eq(s.mfaFactors.userId, id));
      // เครื่องที่เคยจำ 2FA ไว้ต้องยืนยันใหม่
      await tx.update(s.userSessions).set({ mfaTrustedUntil: null }).where(eq(s.userSessions.userId, id));
      await this.trace(tx, staff, id, 'ops.mfa_reset', `รีเซ็ต 2FA ของ ${u.email} · ยืนยันตัวตน: ${proofs} · Ticket ${input.ticketNo} · ${input.reason}`);
    });
    await this.notify(u.email, '2FA ของบัญชี Friday Manage ถูกรีเซ็ต', [`ทีม Friday รีเซ็ต 2FA ตามคำขอใน Ticket ${input.ticketNo}`, 'ตั้ง 2FA ใหม่ตอนเข้าสู่ระบบครั้งถัดไป']);
    return { id, mfaEnabled: false };
  }

  /**
   * เปลี่ยนอีเมล (ยืนยันทั้งสองอีเมล): ทีมยืนยันเจ้าของอีเมลเดิมจากหลักฐาน แล้วส่งลิงก์ไปอีเมลใหม่
   * อีเมลจะเปลี่ยนเมื่อกดลิงก์ (API ลูกค้า `auth/verify-email` ใช้ลิงก์ change_email เดียวกัน และแจ้งอีเมลเดิมอีกครั้ง)
   */
  async changeEmail(staff: Staff, id: string, input: z.infer<typeof ChangeEmailBody>) {
    const u = await this.find(id);
    if (u.disabledAt) throw new AppError(409, 'user_disabled', 'บัญชีนี้ถูกปิดแล้ว');
    if (input.newEmail === u.email.toLowerCase()) throw new AppError(400, 'same_email', 'อีเมลใหม่ต้องไม่ซ้ำกับอีเมลเดิม');
    const [taken] = await this.db.select({ id: s.users.id }).from(s.users).where(sql`lower(${s.users.email}) = ${input.newEmail}`);
    if (taken) throw new AppError(409, 'email_taken', 'อีเมลนี้มีบัญชีแล้ว');
    const proofs = [...new Set(input.proofs)].map((p) => PROOF_LABEL[p]).join(', ');
    const link = await this.db.transaction(async (tx) => {
      const l = await this.issueLink(tx, id, 'change_email', input.newEmail);
      await this.trace(tx, staff, id, 'ops.email_change_requested', `ขอเปลี่ยนอีเมล ${u.email} → ${input.newEmail} (รอยืนยันจากอีเมลใหม่) · ยืนยันตัวตน: ${proofs} · Ticket ${input.ticketNo} · ${input.reason}`);
      return l;
    });
    await this.notify(input.newEmail, 'ยืนยันอีเมลใหม่ของบัญชี Friday Manage', [`กดลิงก์นี้เพื่อยืนยันอีเมลใหม่: ${link}`, `ลิงก์ใช้ได้ ${LINK_MINUTES.change_email} นาที`]);
    await this.notify(u.email, 'มีคำขอเปลี่ยนอีเมลของบัญชี Friday Manage', [`ทีม Friday ส่งลิงก์ยืนยันไปที่ ${input.newEmail} ตาม Ticket ${input.ticketNo}`, 'อีเมลจะเปลี่ยนเมื่อเจ้าของอีเมลใหม่กดยืนยัน']);
    return { id, pendingEmail: input.newEmail };
  }

  async signOutAll(staff: Staff, id: string, input: z.infer<typeof ActionBody>) {
    const u = await this.find(id);
    const revoked = await this.db.transaction(async (tx) => {
      const r = await tx.update(s.userSessions).set({ revokedAt: new Date() }).where(and(eq(s.userSessions.userId, id), isNull(s.userSessions.revokedAt))).returning({ id: s.userSessions.id });
      await this.trace(tx, staff, id, 'ops.sessions_revoked', `ออกจากระบบทุกอุปกรณ์ของ ${u.email} (${r.length} เครื่อง) · Ticket ${input.ticketNo} · ${input.reason}`);
      return r.length;
    });
    await this.notify(u.email, 'บัญชี Friday Manage ออกจากระบบทุกอุปกรณ์แล้ว', [`ทีม Friday ออกจากระบบทุกอุปกรณ์ตาม Ticket ${input.ticketNo} · เข้าสู่ระบบใหม่ได้ตามปกติ`]);
    return { id, revoked };
  }

  /**
   * ปิดบัญชีทั้งระบบ: ล็อกอินไม่ได้ทุก Workspace และคืนที่นั่ง · ข้อมูลงานยังอยู่ (ลบตาม PDPA ใช้หน้าความเป็นส่วนตัว)
   * ปิดไม่ได้ถ้าเป็น Owner คนเดียวของ Workspace ที่ยังใช้งาน (ต้องโอนความเป็นเจ้าของก่อน)
   */
  async close(staff: Staff, id: string, input: z.infer<typeof CloseBody>) {
    const u = await this.find(id);
    if (u.disabledAt) throw new AppError(409, 'user_disabled', 'บัญชีนี้ถูกปิดแล้ว');
    if (input.confirmEmail !== u.email.toLowerCase()) throw new AppError(422, 'confirm_mismatch', 'พิมพ์อีเมลของบัญชีให้ตรงเพื่อยืนยัน');
    const sole = await this.rows<{ id: string; slug: string; name: string }>(sql`
      select w.id, w.slug, w.name from workspace_members m join workspaces w on w.id = m.workspace_id
      where m.user_id = ${id} and m.role = 'owner' and m.status = 'active' and w.deleted_at is null
        and not exists (select 1 from workspace_members o where o.workspace_id = m.workspace_id and o.user_id <> m.user_id and o.role = 'owner' and o.status = 'active')`);
    if (sole.length) throw new AppError(409, 'sole_owner', 'ผู้ใช้นี้เป็น Owner คนเดียวของ Workspace · โอนความเป็นเจ้าของก่อน', { workspaces: sole });
    await this.db.transaction(async (tx) => {
      // เขียนรอยก่อนปิดสมาชิก เพื่อให้ทุก Workspace ที่เคยอยู่เห็นรายการนี้
      await this.trace(tx, staff, id, 'ops.user_closed', `ปิดบัญชี ${u.email} ทั้งระบบ · Ticket ${input.ticketNo} · ${input.reason}`);
      await tx.update(s.users).set({ disabledAt: new Date(), updatedAt: new Date() }).where(eq(s.users.id, id));
      await tx.update(s.userSessions).set({ revokedAt: new Date() }).where(and(eq(s.userSessions.userId, id), isNull(s.userSessions.revokedAt)));
      await tx.update(s.workspaceMembers).set({ status: 'deactivated' }).where(and(eq(s.workspaceMembers.userId, id), eq(s.workspaceMembers.status, 'active')));
    });
    await this.notify(u.email, 'บัญชี Friday Manage ของคุณถูกปิดแล้ว', [`ทีม Friday ปิดบัญชีตามคำขอใน Ticket ${input.ticketNo}`]);
    return { id, status: 'disabled' as const };
  }
}
