import { Injectable } from '@nestjs/common';
import { schema, type Tx } from '@friday/db';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, notFound } from '../common/errors.js';
import { initials, loadPeople } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { assertAdmin, audit } from './shared.js';

const s = schema;
const color = z.string().trim().max(20).nullable().optional();

export const TeamBody = z.object({
  name: z.string().trim().min(1).max(80),
  color,
  leadUserId: z.uuid().nullable().optional(),
  memberIds: z.array(z.uuid()).max(500).optional(),
});
export const PatchTeamBody = TeamBody.omit({ memberIds: true }).partial().strict();
export const MembersBody = z.object({ userIds: z.array(z.uuid()).min(1).max(500) });

/** ทีมในองค์กร (N1) · ใช้กรอง Workload รวม และเพิ่มทั้งทีมเข้าโปรเจกต์ */
@Injectable()
export class TeamsService {
  constructor(private readonly db: TenantDb) {}

  async list(auth: AuthInfo, tenant: TenantInfo) {
    assertAdmin(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const teams = await tx.select().from(s.teams).orderBy(asc(s.teams.name));
      const stats = await this.stats(tx, teams.map((t) => t.id));
      const people = await loadPeople(tx, teams.map((t) => t.leadUserId));
      return { items: teams.map((t) => this.dto(t, stats.get(t.id), people.get(t.leadUserId ?? ''))) };
    });
  }

  async get(auth: AuthInfo, tenant: TenantInfo, id: string) {
    assertAdmin(tenant);
    return this.db.run(auth, tenant, async (tx) => this.detail(tx, await this.find(tx, id)));
  }

  async create(auth: AuthInfo, tenant: TenantInfo, input: z.infer<typeof TeamBody>) {
    assertAdmin(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      await this.assertNameFree(tx, tenant, input.name);
      if (input.leadUserId) await this.assertMembers(tx, [input.leadUserId]);
      const memberIds = [...new Set(input.memberIds ?? [])];
      if (memberIds.length) await this.assertMembers(tx, memberIds);
      const [team] = await tx.insert(s.teams).values({ workspaceId: tenant.workspaceId, name: input.name, color: input.color ?? null, leadUserId: input.leadUserId ?? null }).returning();
      if (memberIds.length) await tx.insert(s.teamMembers).values(memberIds.map((userId) => ({ workspaceId: tenant.workspaceId, teamId: team.id, userId })));
      await audit(tx, auth, tenant, 'perm', 'team.created', `สร้างทีม ${team.name} (${memberIds.length} คน)`, { type: 'team', id: team.id });
      return this.detail(tx, team);
    });
  }

  async patch(auth: AuthInfo, tenant: TenantInfo, id: string, input: z.infer<typeof PatchTeamBody>) {
    assertAdmin(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const cur = await this.find(tx, id);
      if (input.name && input.name.toLowerCase() !== cur.name.toLowerCase()) await this.assertNameFree(tx, tenant, input.name, cur.id);
      if (input.leadUserId) await this.assertMembers(tx, [input.leadUserId]);
      const [team] = await tx
        .update(s.teams)
        .set({ ...(input.name !== undefined ? { name: input.name } : {}), ...(input.color !== undefined ? { color: input.color } : {}), ...(input.leadUserId !== undefined ? { leadUserId: input.leadUserId } : {}) })
        .where(eq(s.teams.id, cur.id))
        .returning();
      await audit(tx, auth, tenant, 'perm', 'team.updated', `แก้ทีม ${team.name}: ${Object.keys(input).join(', ') || '-'}`, { type: 'team', id: team.id });
      return this.detail(tx, team);
    });
  }

  async remove(auth: AuthInfo, tenant: TenantInfo, id: string) {
    assertAdmin(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const cur = await this.find(tx, id);
      await tx.delete(s.teams).where(eq(s.teams.id, cur.id));
      await audit(tx, auth, tenant, 'perm', 'team.deleted', `ลบทีม ${cur.name}`, { type: 'team', id: cur.id });
      return { id: cur.id, deleted: true };
    });
  }

  async addMembers(auth: AuthInfo, tenant: TenantInfo, id: string, input: z.infer<typeof MembersBody>) {
    assertAdmin(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const team = await this.find(tx, id);
      const ids = [...new Set(input.userIds)];
      await this.assertMembers(tx, ids);
      const rows = await tx.insert(s.teamMembers).values(ids.map((userId) => ({ workspaceId: tenant.workspaceId, teamId: team.id, userId }))).onConflictDoNothing().returning({ userId: s.teamMembers.userId });
      if (rows.length) await audit(tx, auth, tenant, 'perm', 'team.members_added', `เพิ่มสมาชิกทีม ${team.name} ${rows.length} คน`, { type: 'team', id: team.id });
      return this.detail(tx, team);
    });
  }

  async removeMember(auth: AuthInfo, tenant: TenantInfo, id: string, userId: string) {
    assertAdmin(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const team = await this.find(tx, id);
      if (!z.uuid().safeParse(userId).success) throw notFound('สมาชิกทีม');
      const gone = await tx.delete(s.teamMembers).where(and(eq(s.teamMembers.teamId, team.id), eq(s.teamMembers.userId, userId))).returning({ userId: s.teamMembers.userId });
      if (!gone.length) throw notFound('สมาชิกทีม');
      // หัวหน้าทีมที่ออกจากทีม = ไม่มีหัวหน้า
      if (team.leadUserId === userId) await tx.update(s.teams).set({ leadUserId: null }).where(eq(s.teams.id, team.id));
      await audit(tx, auth, tenant, 'perm', 'team.member_removed', `เอาสมาชิกออกจากทีม ${team.name}`, { type: 'team', id: team.id });
      return this.detail(tx, { ...team, leadUserId: team.leadUserId === userId ? null : team.leadUserId });
    });
  }

  // ---------------------------------------------------------------------------

  private async find(tx: Tx, id: string) {
    if (!z.uuid().safeParse(id).success) throw notFound('ทีม');
    const [team] = await tx.select().from(s.teams).where(eq(s.teams.id, id));
    if (!team) throw notFound('ทีม');
    return team;
  }

  private async assertNameFree(tx: Tx, tenant: TenantInfo, name: string, exceptId?: string) {
    const [dup] = await tx.select({ id: s.teams.id }).from(s.teams).where(and(eq(s.teams.workspaceId, tenant.workspaceId), sql`lower(${s.teams.name}) = lower(${name})`, exceptId ? ne(s.teams.id, exceptId) : undefined));
    if (dup) throw new AppError(409, 'team_name_taken', 'มีทีมชื่อนี้แล้ว');
  }

  /** สมาชิกทีมต้องเป็นสมาชิก active ของ Workspace (ไม่ใช่ Guest) */
  private async assertMembers(tx: Tx, ids: string[]) {
    const ok = await tx
      .select({ id: s.workspaceMembers.userId })
      .from(s.workspaceMembers)
      .where(and(inArray(s.workspaceMembers.userId, ids), eq(s.workspaceMembers.status, 'active'), ne(s.workspaceMembers.role, 'guest')));
    const have = new Set(ok.map((x) => x.id));
    const missing = ids.filter((i) => !have.has(i));
    if (missing.length) throw new AppError(400, 'invalid_team_members', 'ใส่ได้เฉพาะสมาชิก (ไม่ใช่ Guest) ที่ยังใช้งานอยู่ใน Workspace', { userIds: missing });
  }

  /** จำนวนคน, Capacity (MD/สัปดาห์ = ชั่วโมง ÷ 8) และจำนวนโปรเจกต์ที่สมาชิกอยู่ */
  private async stats(tx: Tx, teamIds: string[]) {
    const out = new Map<string, { members: number; capacityMd: number; projects: number }>();
    if (!teamIds.length) return out;
    const rows = await tx
      .select({
        teamId: s.teamMembers.teamId,
        members: sql<number>`count(*)::int`,
        hours: sql<number>`coalesce(sum(${s.workspaceMembers.capacityHoursWeek}), 0)::int`,
        projects: sql<number>`(select count(distinct pm.project_id)::int from project_members pm join team_members tm2 on tm2.user_id = pm.user_id where tm2.team_id = ${s.teamMembers.teamId})`,
      })
      .from(s.teamMembers)
      .innerJoin(s.workspaceMembers, eq(s.workspaceMembers.userId, s.teamMembers.userId))
      .where(inArray(s.teamMembers.teamId, teamIds))
      .groupBy(s.teamMembers.teamId);
    for (const r of rows) out.set(r.teamId, { members: r.members, capacityMd: Math.round((r.hours / 8) * 100) / 100, projects: r.projects });
    return out;
  }

  private dto(t: typeof s.teams.$inferSelect, st: { members: number; capacityMd: number; projects: number } | undefined, lead: { id: string; displayName: string; initials: string; avatarUrl: string | null } | undefined) {
    return { id: t.id, name: t.name, color: t.color, lead: lead ?? null, memberCount: st?.members ?? 0, capacityMdWeek: st?.capacityMd ?? 0, projectCount: st?.projects ?? 0, createdAt: t.createdAt };
  }

  private async detail(tx: Tx, team: typeof s.teams.$inferSelect) {
    const stats = await this.stats(tx, [team.id]);
    const members = await tx
      .select({ id: s.users.id, displayName: s.users.displayName, avatarUrl: s.users.avatarUrl, role: s.workspaceMembers.role, jobTitle: s.workspaceMembers.jobTitle, capacityHoursWeek: s.workspaceMembers.capacityHoursWeek })
      .from(s.teamMembers)
      .innerJoin(s.users, eq(s.users.id, s.teamMembers.userId))
      .innerJoin(s.workspaceMembers, eq(s.workspaceMembers.userId, s.teamMembers.userId))
      .where(eq(s.teamMembers.teamId, team.id))
      .orderBy(asc(s.users.displayName));
    const lead = members.find((m) => m.id === team.leadUserId);
    const leadPerson = lead ? { id: lead.id, displayName: lead.displayName, initials: initials(lead.displayName), avatarUrl: lead.avatarUrl } : (await loadPeople(tx, [team.leadUserId])).get(team.leadUserId ?? '');
    return { ...this.dto(team, stats.get(team.id), leadPerson), members: members.map((m) => ({ id: m.id, displayName: m.displayName, initials: initials(m.displayName), avatarUrl: m.avatarUrl, role: m.role, jobTitle: m.jobTitle, capacityHoursWeek: m.capacityHoursWeek })) };
  }
}
