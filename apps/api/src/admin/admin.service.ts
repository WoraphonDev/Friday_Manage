import { BlockList, isIP } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, notFound } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { type DomainEvent, EventBus } from '../core/events.js';
import { PlanLimits } from '../core/plan-limits.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { CalendarsService, type Recalculated } from './calendars.service.js';
import { assertAdmin, audit } from './shared.js';

const s = schema;
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'เวลาต้องเป็น HH:MM');
const SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;

export const PatchSettingsBody = z
  .object({
    workStart: time,
    workEnd: time,
    /** ISO weekday 1 = จันทร์ … 7 = อาทิตย์ */
    workDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    sizeMdMap: z.object({ XS: z.number().positive().max(100), S: z.number().positive().max(100), M: z.number().positive().max(100), L: z.number().positive().max(100), XL: z.number().positive().max(100) }).strict(),
    allowProjectOverride: z.boolean(),
    safeMode: z.boolean(),
    trashDays: z.union([z.literal(30), z.literal(90)]),
    /** null = เก็บถาวร */
    archiveRetentionYears: z.number().int().min(1).max(10).nullable(),
    requireConsentOnFirstLogin: z.boolean(),
    holidayCalendarId: z.uuid().nullable(),
  })
  .partial()
  .strict();

const domain = z.string().trim().toLowerCase().regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'โดเมนไม่ถูกต้อง');
export const PatchSecurityBody = z
  .object({
    passwordMinLength: z.number().int().min(8).max(64),
    passwordRequireSpecial: z.boolean(),
    /** null = ไม่บังคับเปลี่ยน */
    passwordRotationDays: z.number().int().min(30).max(365).nullable(),
    lockoutAttempts: z.number().int().min(3).max(20),
    lockoutMinutes: z.number().int().min(1).max(1440),
    sessionIdleHours: z.number().int().min(1).max(168),
    mfaEnforcement: z.enum(['none', 'admin', 'all']),
    allowedEmailDomains: z.array(domain).max(20),
    ipAllowlist: z.array(z.string().trim().min(2).max(60)).max(50),
  })
  .partial()
  .strict();

const isoDate = z.iso.date();
export const AuditQuery = z.object({
  category: z.enum(['perm', 'data', 'secu', 'plan', 'notify']).optional(),
  user: z.uuid().optional(),
  action: z.string().trim().max(80).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** ISO เวลาของรายการสุดท้ายที่เห็น (ใหม่ → เก่า) */
  before: z.iso.datetime({ offset: true }).optional(),
});

/** IP หรือ CIDR ที่ใช้ได้ (IPv4 / IPv6) */
function parseRule(rule: string): { ip: string; prefix?: number; family: 'ipv4' | 'ipv6' } | null {
  const [ip, mask] = rule.split('/');
  const v = isIP(ip);
  if (!v) return null;
  if (mask === undefined) return { ip, family: v === 4 ? 'ipv4' : 'ipv6' };
  const prefix = Number(mask);
  if (!/^\d+$/.test(mask) || prefix < 0 || prefix > (v === 4 ? 32 : 128)) return null;
  return { ip, prefix, family: v === 4 ? 'ipv4' : 'ipv6' };
}
export function ipAllowed(rules: string[], rawIp: string | undefined) {
  if (!rules.length) return true;
  if (!rawIp) return false;
  const ip = rawIp.replace(/^::ffff:/, '');
  const list = new BlockList();
  for (const r of rules) {
    const p = parseRule(r)!;
    if (p.prefix === undefined) list.addAddress(p.ip, p.family);
    else list.addSubnet(p.ip, p.prefix, p.family);
  }
  return list.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}

export const csvCell = (v: unknown) => {
  let t = v === null || v === undefined ? '' : String(v);
  // กัน CSV injection เมื่อเปิดใน Excel
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
/** เวลาไทย (UTC+7) ครอบทั้งวัน */
const dayStart = (d: string) => new Date(`${d}T00:00:00+07:00`);
const dayEnd = (d: string) => new Date(new Date(`${d}T00:00:00+07:00`).getTime() + 86_400_000);

@Injectable()
export class AdminService {
  constructor(
    private readonly db: TenantDb,
    @Inject(SYSTEM_DB) private readonly sys: Db,
    private readonly limits: PlanLimits,
    private readonly calendars: CalendarsService,
    private readonly events: EventBus,
  ) {}

  // ---------------------------------------------------------------------------
  // ภาพรวม (N1)
  // ---------------------------------------------------------------------------

  async overview(auth: AuthInfo, tenant: TenantInfo) {
    assertAdmin(tenant);
    const mfa = await this.mfaStats(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const plan = await this.limits.snapshot(tx, tenant.workspaceId);
      const [policy] = await tx.select({ mfa: s.securityPolicies.mfaEnforcement }).from(s.securityPolicies).where(eq(s.securityPolicies.workspaceId, tenant.workspaceId));
      const [users] = await tx
        .select({
          active: sql<number>`count(*) filter (where ${s.workspaceMembers.role} <> 'guest')::int`,
          guests: sql<number>`count(*) filter (where ${s.workspaceMembers.role} = 'guest')::int`,
          active7d: sql<number>`count(*) filter (where ${s.workspaceMembers.lastActiveAt} >= now() - interval '7 days')::int`,
        })
        .from(s.workspaceMembers)
        .where(eq(s.workspaceMembers.status, 'active'));
      const [projects] = await tx
        .select({
          active: sql<number>`count(*) filter (where ${s.projects.archivedAt} is null)::int`,
          archived: sql<number>`count(*) filter (where ${s.projects.archivedAt} is not null)::int`,
        })
        .from(s.projects)
        .where(isNull(s.projects.deletedAt));
      const [issues] = await tx
        .select({
          total: sql<number>`count(*)::int`,
          open: sql<number>`count(*) filter (where ${s.workflowStatuses.category} <> 'done')::int`,
        })
        .from(s.issues)
        .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
        .where(isNull(s.issues.deletedAt));
      const weekly = await tx.execute<{ week: string; n: number }>(sql`
        select to_char(date_trunc('week', created_at at time zone 'Asia/Bangkok'), 'YYYY-MM-DD') as week, count(distinct actor_id)::int as n
        from activities
        where actor_kind = 'user' and actor_id is not null and created_at >= now() - interval '8 weeks'
        group by 1 order by 1`);
      const [pending] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.accessRequests).where(eq(s.accessRequests.status, 'pending'));
      const rows = await tx
        .select({
          id: s.projects.id,
          key: s.projects.key,
          name: s.projects.name,
          visibility: s.projects.visibility,
          status: s.projects.status,
          archivedAt: s.projects.archivedAt,
          pm: s.users.displayName,
          pmId: s.projects.ownerUserId,
          members: sql<number>`(select count(*)::int from project_members pm where pm.project_id = ${s.projects.id})`,
          lastActivityAt: sql<Date | null>`(select max(a.created_at) from activities a where a.project_id = ${s.projects.id})`,
        })
        .from(s.projects)
        .leftJoin(s.users, eq(s.users.id, s.projects.ownerUserId))
        .where(isNull(s.projects.deletedAt))
        .orderBy(s.projects.key);

      const over = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from workspace_members wm
        where wm.status = 'active' and (select coalesce(sum(pm.capacity_hours_week), 0) from project_members pm where pm.user_id = wm.user_id) > wm.capacity_hours_week`);
      const actions: { code: string; count: number; message: string }[] = [];
      if (pending.n) actions.push({ code: 'access_requests_pending', count: pending.n, message: `มีคำขอเข้าร่วม ${pending.n} รายการรออนุมัติ` });
      if (policy && policy.mfa !== 'none' && mfa.missing.length) actions.push({ code: 'mfa_missing', count: mfa.missing.length, message: `มี ${mfa.missing.length} คนที่ยังไม่เปิด 2FA ทั้งที่องค์กรบังคับ` });
      const overCount = Number((over as unknown as { rows?: { n: number }[] }).rows?.[0]?.n ?? (over as unknown as { n: number }[])[0]?.n ?? 0);
      if (overCount) actions.push({ code: 'over_capacity', count: overCount, message: `${overCount} คนถูกแบ่งเวลาให้โปรเจกต์เกินเวลาทั้งหมด` });
      if (plan.limits.seats !== null && plan.usage.seats >= plan.limits.seats * 0.9) actions.push({ code: 'seats_near_limit', count: plan.usage.seats, message: `ใช้ที่นั่ง ${plan.usage.seats} / ${plan.limits.seats}` });
      const trialEnd = plan.subscription.trialEndsAt;
      if (plan.subscription.status === 'trialing' && trialEnd) {
        const days = Math.ceil((trialEnd.getTime() - Date.now()) / 86_400_000);
        if (days <= 3) actions.push({ code: 'trial_ending', count: Math.max(days, 0), message: `ช่วงทดลองใช้จะสิ้นสุดใน ${Math.max(days, 0)} วัน` });
      }

      const wk = ((weekly as unknown as { rows?: { week: string; n: number }[] }).rows ?? (weekly as unknown as { week: string; n: number }[]));
      return {
        plan: { code: plan.plan.code, name: plan.plan.name, status: plan.subscription.status, trialEndsAt: plan.subscription.trialEndsAt },
        users: { active: users?.active ?? 0, seatLimit: plan.limits.seats, guests: users?.guests ?? 0, activeLast7Days: users?.active7d ?? 0 },
        projects: { active: projects?.active ?? 0, archived: projects?.archived ?? 0, limit: plan.limits.projects },
        storage: { usedBytes: plan.usage.storage_bytes, limitBytes: plan.limits.storage_bytes },
        issues: { total: issues?.total ?? 0, open: issues?.open ?? 0 },
        weeklyActiveUsers: wk.map((w) => ({ week: w.week, users: w.n })),
        mfa: { enabled: mfa.enabled, total: mfa.total },
        actions,
        projectList: rows.map((p) => ({
          id: p.id,
          key: p.key,
          name: p.name,
          visibility: p.visibility,
          status: p.archivedAt ? 'archived' : p.status,
          pm: p.pmId ? { id: p.pmId, displayName: p.pm } : null,
          memberCount: p.members,
          lastActivityAt: p.lastActivityAt,
        })),
      };
    });
  }

  /** ใครเปิด 2FA แล้ว · mfa_factors อ่านได้เฉพาะแถวของตัวเองใน RLS จึงใช้ SYSTEM_DB โดยจำกัดที่สมาชิก active ของ Workspace นี้เท่านั้น */
  private async mfaStats(tenant: TenantInfo) {
    const members = await this.sys
      .select({ id: s.workspaceMembers.userId, displayName: s.users.displayName, email: s.users.email })
      .from(s.workspaceMembers)
      .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
      .where(and(eq(s.workspaceMembers.workspaceId, tenant.workspaceId), eq(s.workspaceMembers.status, 'active')));
    const on = members.length
      ? new Set((await this.sys.select({ userId: s.mfaFactors.userId }).from(s.mfaFactors).where(and(inArray(s.mfaFactors.userId, members.map((m) => m.id)), sql`${s.mfaFactors.enabledAt} is not null`))).map((x) => x.userId))
      : new Set<string>();
    return { total: members.length, enabled: on.size, missing: members.filter((m) => !on.has(m.id)) };
  }

  // ---------------------------------------------------------------------------
  // ตั้งค่า Workspace
  // ---------------------------------------------------------------------------

  async getSettings(auth: AuthInfo, tenant: TenantInfo) {
    assertAdmin(tenant);
    return this.db.run(auth, tenant, (tx) => this.settingsDto(tx, tenant));
  }

  async patchSettings(auth: AuthInfo, tenant: TenantInfo, input: z.infer<typeof PatchSettingsBody>) {
    assertAdmin(tenant);
    let events: DomainEvent[] = [];
    const result = await this.db.run(auth, tenant, async (tx) => {
      const [cur] = await tx.select().from(s.workspaceSettings).where(eq(s.workspaceSettings.workspaceId, tenant.workspaceId));
      if (!cur) throw notFound('การตั้งค่า Workspace');
      const next = { ...cur, ...input };
      if (next.workEnd <= next.workStart) throw new AppError(400, 'invalid_work_hours', 'เวลาเลิกงานต้องหลังเวลาเริ่มงาน');
      if (input.workDays) input.workDays = [...new Set(input.workDays)].sort();
      if (input.sizeMdMap) {
        const v = SIZES.map((k) => input.sizeMdMap![k]);
        if (v.some((x, i) => i > 0 && x < v[i - 1])) throw new AppError(400, 'invalid_size_map', 'Man-Day ของ Size ที่ใหญ่ขึ้นต้องไม่น้อยกว่า Size ที่เล็กกว่า');
      }
      if (input.holidayCalendarId) {
        const [cal] = await tx.select({ id: s.holidayCalendars.id }).from(s.holidayCalendars).where(eq(s.holidayCalendars.id, input.holidayCalendarId));
        if (!cal) throw new AppError(400, 'calendar_not_found', 'ไม่พบปฏิทินที่เลือก');
      }
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      const changed = (Object.keys(input) as (keyof typeof input)[]).filter((k) => !same(input[k], cur[k as keyof typeof cur]));
      if (!changed.length) return { ...(await this.settingsDto(tx, tenant)), recalculated: { projects: 0, issues: 0 } as Recalculated };

      // วันทำงาน / ปฏิทินเริ่มต้นเปลี่ยน = Plan End ของงานที่คร่อมวันที่เปลี่ยนต้องคิดใหม่
      const affectsPlan = changed.includes('workDays') || changed.includes('holidayCalendarId');
      const snap = affectsPlan ? await this.calendars.snapshot(tx, tenant) : [];
      await tx.update(s.workspaceSettings).set({ ...input, updatedAt: new Date() }).where(eq(s.workspaceSettings.workspaceId, tenant.workspaceId));
      const r = affectsPlan ? await this.calendars.recalculate(tx, auth, snap) : { events: [], recalculated: { projects: 0, issues: 0 } };
      events = r.events;
      await audit(tx, auth, tenant, changed.includes('safeMode') ? 'notify' : 'data', 'workspace.settings_updated', `แก้การตั้งค่า: ${changed.join(', ')}${r.recalculated.issues ? ` · คำนวณแผนใหม่ ${r.recalculated.issues} งาน` : ''}`, { type: 'workspace', id: tenant.workspaceId });
      return { ...(await this.settingsDto(tx, tenant)), recalculated: r.recalculated };
    });
    await this.events.publish(events);
    return result;
  }

  private async settingsDto(tx: Tx, tenant: TenantInfo) {
    const [r] = await tx.select().from(s.workspaceSettings).where(eq(s.workspaceSettings.workspaceId, tenant.workspaceId));
    if (!r) throw notFound('การตั้งค่า Workspace');
    return {
      workStart: r.workStart.slice(0, 5),
      workEnd: r.workEnd.slice(0, 5),
      workDays: r.workDays,
      sizeMdMap: r.sizeMdMap as Record<(typeof SIZES)[number], number>,
      allowProjectOverride: r.allowProjectOverride,
      safeMode: r.safeMode,
      trashDays: r.trashDays,
      archiveRetentionYears: r.archiveRetentionYears,
      requireConsentOnFirstLogin: r.requireConsentOnFirstLogin,
      holidayCalendarId: r.holidayCalendarId,
      dataRegion: 'th-bangkok',
    };
  }

  // ---------------------------------------------------------------------------
  // นโยบายความปลอดภัย
  // ---------------------------------------------------------------------------

  async getSecurity(auth: AuthInfo, tenant: TenantInfo) {
    assertAdmin(tenant);
    const mfa = await this.mfaStats(tenant);
    return this.db.run(auth, tenant, async (tx) => ({ ...(await this.securityDto(tx, tenant)), mfa: { enabled: mfa.enabled, total: mfa.total, missing: mfa.missing.map((m) => ({ id: m.id, displayName: m.displayName })) } }));
  }

  async patchSecurity(auth: AuthInfo, tenant: TenantInfo, input: z.infer<typeof PatchSecurityBody>, requestIp: string | undefined) {
    assertAdmin(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const cur = await this.securityRow(tx, tenant);
      if (input.ipAllowlist) {
        const bad = input.ipAllowlist.filter((r) => !parseRule(r));
        if (bad.length) throw new AppError(400, 'invalid_ip_allowlist', 'IP หรือ CIDR ไม่ถูกต้อง', { invalid: bad });
        // กันผู้แก้ล็อกตัวเองออกจากระบบ
        if (!ipAllowed(input.ipAllowlist, requestIp)) throw new AppError(422, 'ip_allowlist_locks_you_out', 'IP ปัจจุบันของคุณไม่อยู่ในรายการ · เพิ่ม IP ของคุณก่อนบันทึก', { yourIp: requestIp?.replace(/^::ffff:/, '') ?? null });
        input.ipAllowlist = [...new Set(input.ipAllowlist)];
      }
      if (input.allowedEmailDomains) input.allowedEmailDomains = [...new Set(input.allowedEmailDomains)];
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      const changed = (Object.keys(input) as (keyof typeof input)[]).filter((k) => !same(input[k], cur[k as keyof typeof cur]));
      if (changed.length) {
        await tx.update(s.securityPolicies).set({ ...input, updatedAt: new Date() }).where(eq(s.securityPolicies.workspaceId, tenant.workspaceId));
        await audit(tx, auth, tenant, 'secu', 'security_policy.updated', `แก้นโยบายความปลอดภัย: ${changed.join(', ')}`, { type: 'workspace', id: tenant.workspaceId });
      }
      return this.securityDto(tx, tenant);
    });
  }

  private async securityRow(tx: Tx, tenant: TenantInfo) {
    let [row] = await tx.select().from(s.securityPolicies).where(eq(s.securityPolicies.workspaceId, tenant.workspaceId));
    if (!row) [row] = await tx.insert(s.securityPolicies).values({ workspaceId: tenant.workspaceId }).returning();
    return row;
  }

  private async securityDto(tx: Tx, tenant: TenantInfo) {
    const r = await this.securityRow(tx, tenant);
    return {
      passwordMinLength: r.passwordMinLength,
      passwordRequireSpecial: r.passwordRequireSpecial,
      passwordRotationDays: r.passwordRotationDays,
      lockoutAttempts: r.lockoutAttempts,
      lockoutMinutes: r.lockoutMinutes,
      sessionIdleHours: r.sessionIdleHours,
      mfaEnforcement: r.mfaEnforcement,
      allowedEmailDomains: r.allowedEmailDomains,
      ipAllowlist: r.ipAllowlist,
    };
  }

  // ---------------------------------------------------------------------------
  // Audit log (`ws.audit.view`)
  // ---------------------------------------------------------------------------

  private auditWhere(q: z.infer<typeof AuditQuery>) {
    return and(
      q.category ? eq(s.auditLogs.category, q.category) : undefined,
      q.user ? eq(s.auditLogs.actorId, q.user) : undefined,
      q.action ? eq(s.auditLogs.action, q.action) : undefined,
      q.from ? gte(s.auditLogs.createdAt, dayStart(q.from)) : undefined,
      q.to ? lt(s.auditLogs.createdAt, dayEnd(q.to)) : undefined,
      q.before ? lt(s.auditLogs.createdAt, new Date(q.before)) : undefined,
    );
  }

  async auditLog(auth: AuthInfo, tenant: TenantInfo, q: z.infer<typeof AuditQuery>) {
    assertAdmin(tenant, 'ws.audit.view');
    return this.db.run(auth, tenant, async (tx) => {
      const rows = await tx
        .select({ log: s.auditLogs, name: s.users.displayName })
        .from(s.auditLogs)
        .leftJoin(s.users, eq(s.users.id, s.auditLogs.actorId))
        .where(this.auditWhere(q))
        .orderBy(desc(s.auditLogs.createdAt), desc(s.auditLogs.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      return {
        items: page.map(({ log, name }) => ({
          id: log.id,
          at: log.createdAt,
          actor: { id: log.actorId, kind: log.actorKind, displayName: name },
          category: log.category,
          action: log.action,
          target: log.targetType ? { type: log.targetType, id: log.targetId } : null,
          summary: log.summary,
          ip: log.ip,
        })),
        nextCursor: rows.length > q.limit ? page[page.length - 1].log.createdAt.toISOString() : null,
      };
    });
  }

  async auditCsv(auth: AuthInfo, tenant: TenantInfo, q: z.infer<typeof AuditQuery>) {
    assertAdmin(tenant, 'ws.audit.view');
    return this.db.run(auth, tenant, async (tx) => {
      const rows = await tx
        .select({ log: s.auditLogs, name: s.users.displayName })
        .from(s.auditLogs)
        .leftJoin(s.users, eq(s.users.id, s.auditLogs.actorId))
        .where(this.auditWhere({ ...q, before: undefined }))
        .orderBy(desc(s.auditLogs.createdAt), desc(s.auditLogs.id))
        .limit(50_000);
      const lines = [['เวลา', 'ผู้ใช้', 'ประเภทผู้กระทำ', 'หมวด', 'การกระทำ', 'ชนิดรายการ', 'รหัสรายการ', 'รายละเอียด', 'IP'].map(csvCell).join(',')];
      for (const { log, name } of rows) {
        lines.push([log.createdAt.toISOString(), name ?? '', log.actorKind, log.category, log.action, log.targetType, log.targetId, log.summary, log.ip].map(csvCell).join(','));
      }
      // การ export Audit log เองก็ต้องมีรอยไว้
      await audit(tx, auth, tenant, 'secu', 'audit_log.exported', `Export Audit log ${rows.length} รายการ`, { type: 'workspace', id: tenant.workspaceId });
      // BOM ให้ Excel เปิดภาษาไทยถูก
      return { filename: `audit-log-${tenant.slug}.csv`, content: `﻿${lines.join('\r\n')}\r\n`, count: rows.length };
    });
  }
}

