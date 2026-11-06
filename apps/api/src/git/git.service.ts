import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { webUrl } from '../auth/auth.config.js';
import { signToken, verifyToken } from '../auth/crypto.js';
import { AppError, forbidden, notFound } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { IssuesService } from '../issues/issues.service.js';
import { requirePerm } from '../projects/permissions.js';
import { ProjectsService } from '../projects/projects.service.js';
import { Jobs } from '../queue/jobs.js';
import { GitEventsService } from './git-events.js';
import { GithubApi } from './github-api.js';

const s = schema;
const Id = z.uuid();
export const GIT_JOB = 'git.process';

export const LinkRepoBody = z.object({
  repositoryId: Id,
  /** glob เช่น `feature/*` · ว่าง = ทุก branch */
  branchPattern: z.string().trim().min(1).max(100).nullish(),
  onFirstCommitStatusId: Id.nullish(),
  onPrOpenStatusId: Id.nullish(),
  onMergeStatusId: Id.nullish(),
  notifyOnCiFail: z.boolean().default(true),
});
export const PatchRepoBody = z
  .object({ branchPattern: z.string().trim().min(1).max(100).nullable(), onFirstCommitStatusId: Id.nullable(), onPrOpenStatusId: Id.nullable(), onMergeStatusId: Id.nullable(), notifyOnCiFail: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'ต้องระบุค่าที่จะแก้');

const isAdmin = (t: TenantInfo) => t.role === 'owner' || t.role === 'admin';

/** I · เชื่อม GitHub: ติดตั้ง App, repository ของโปรเจกต์ และ Commit / PR ของงาน */
@Injectable()
export class GitService {
  constructor(
    private readonly db: TenantDb,
    @Inject(SYSTEM_DB) private readonly system: Db,
    private readonly github: GithubApi,
    private readonly projects: ProjectsService,
    private readonly issues: IssuesService,
    private readonly jobs: Jobs,
    private readonly processor: GitEventsService,
  ) {}

  async onModuleInit() {
    this.jobs.define<{ event: string; payload: Record<string, unknown> }>(GIT_JOB, (d) => this.processor.handle(d.event, d.payload));
  }

  // ---------------------------------------------------------------------------
  // w/integrations/git
  // ---------------------------------------------------------------------------
  /** URL ไปหน้าติดตั้ง GitHub App · state ลงลายมือชื่อ ผูกกับ Workspace + ผู้กด และหมดอายุใน 15 นาที */
  installUrl(auth: AuthInfo, tenant: TenantInfo) {
    if (!isAdmin(tenant)) throw forbidden('ws.settings');
    if (!this.github.configured) throw new AppError(409, 'github_not_configured', 'ยังไม่ได้ตั้งค่า GitHub App ของระบบ (GITHUB_APP_ID / GITHUB_APP_SLUG / GITHUB_APP_PRIVATE_KEY)');
    return { url: this.github.installUrl(signToken('github-install', { w: tenant.workspaceId, u: auth.userId }, 900)) };
  }

  /** `GET hooks/github/setup` · GitHub พากลับมาหลังติดตั้ง · คืน URL หน้าเว็บที่จะ redirect ไป */
  async setup(installationId: string, state: string, action?: string) {
    const claims = verifyToken<{ w: string; u: string }>('github-install', state);
    if (!claims || !/^\d{1,20}$/.test(installationId)) throw new AppError(400, 'invalid_state', 'ลิงก์ติดตั้งไม่ถูกต้องหรือหมดอายุ · เริ่มติดตั้งใหม่จาก Admin Console');
    const [ws] = await this.system.select().from(s.workspaces).where(and(eq(s.workspaces.id, claims.w), isNull(s.workspaces.deletedAt)));
    const [member] = await this.system.select({ role: s.workspaceMembers.role }).from(s.workspaceMembers).where(and(eq(s.workspaceMembers.workspaceId, claims.w), eq(s.workspaceMembers.userId, claims.u), eq(s.workspaceMembers.status, 'active')));
    if (!ws || !member || !['owner', 'admin'].includes(member.role)) throw new AppError(403, 'forbidden', 'ผู้เริ่มติดตั้งไม่มีสิทธิ์ตั้งค่า Integration แล้ว', { permission: 'ws.settings' });
    if (action === 'request') return `${webUrl()}/w/${ws.slug}/admin/integrations?github=pending`;
    const account = await this.github.installation(installationId);
    const [taken] = await this.system.select().from(s.gitInstallations).where(and(eq(s.gitInstallations.provider, 'github'), eq(s.gitInstallations.externalInstallationId, installationId)));
    if (taken && taken.workspaceId !== ws.id) throw new AppError(409, 'installation_taken', 'การติดตั้งนี้ผูกกับ Workspace อื่นอยู่แล้ว');
    const [inst] = taken
      ? await this.system.update(s.gitInstallations).set({ accountName: account.accountName, status: 'active' }).where(eq(s.gitInstallations.id, taken.id)).returning()
      : await this.system.insert(s.gitInstallations).values({ workspaceId: ws.id, provider: 'github', accountName: account.accountName, externalInstallationId: installationId }).returning();
    await this.syncRepos(inst!);
    await this.system.insert(s.auditLogs).values({ workspaceId: ws.id, actorId: claims.u, actorKind: 'user', category: 'secu', action: 'integration.github_installed', targetType: 'git_installation', targetId: inst!.id, summary: account.accountName });
    return `${webUrl()}/w/${ws.slug}/admin/integrations?github=connected`;
  }

  private async syncRepos(inst: typeof s.gitInstallations.$inferSelect) {
    const repos = await this.github.repositories(inst.externalInstallationId);
    for (const r of repos) {
      await this.system.insert(s.gitRepositories).values({ workspaceId: inst.workspaceId, installationId: inst.id, fullName: r.fullName, defaultBranch: r.defaultBranch }).onConflictDoUpdate({ target: [s.gitRepositories.installationId, s.gitRepositories.fullName], set: { defaultBranch: r.defaultBranch } });
    }
    // repository ที่ App เข้าไม่ถึงแล้วเอาออก (การผูกกับโปรเจกต์หายตาม cascade)
    const have = await this.system.select().from(s.gitRepositories).where(eq(s.gitRepositories.installationId, inst.id));
    const keep = new Set(repos.map((r) => r.fullName));
    const gone = have.filter((h) => !keep.has(h.fullName)).map((h) => h.id);
    if (gone.length) await this.system.delete(s.gitRepositories).where(inArray(s.gitRepositories.id, gone));
    return repos.length;
  }

  async listIntegrations(auth: AuthInfo, tenant: TenantInfo) {
    if (!isAdmin(tenant)) throw forbidden('ws.settings');
    return this.db.run(auth, tenant, async (tx) => {
      const insts = await tx.select().from(s.gitInstallations).orderBy(asc(s.gitInstallations.accountName));
      const repos = insts.length ? await tx.select().from(s.gitRepositories).orderBy(asc(s.gitRepositories.fullName)) : [];
      const used = repos.length ? await tx.select({ repositoryId: s.projectRepositories.repositoryId, key: s.projects.key }).from(s.projectRepositories).innerJoin(s.projects, eq(s.projects.id, s.projectRepositories.projectId)) : [];
      return {
        configured: this.github.configured,
        items: insts.map((i) => ({
          id: i.id,
          provider: i.provider,
          accountName: i.accountName,
          status: i.status,
          createdAt: i.createdAt,
          repositories: repos.filter((r) => r.installationId === i.id).map((r) => ({ id: r.id, fullName: r.fullName, defaultBranch: r.defaultBranch, projects: used.filter((u) => u.repositoryId === r.id).map((u) => u.key) })),
        })),
      };
    });
  }

  async repositories(auth: AuthInfo, tenant: TenantInfo, id: string) {
    const all = await this.listIntegrations(auth, tenant);
    const inst = all.items.find((i) => i.id === id);
    if (!inst) throw notFound('การติดตั้ง');
    return { items: inst.repositories };
  }

  /** ดึงรายการ repository ใหม่จาก GitHub (เมื่อเพิ่ม repo ให้ App ภายหลัง) */
  async sync(auth: AuthInfo, tenant: TenantInfo, id: string) {
    if (!isAdmin(tenant)) throw forbidden('ws.settings');
    const [inst] = await this.db.run(auth, tenant, (tx) => tx.select().from(s.gitInstallations).where(eq(s.gitInstallations.id, Id.parse(id))));
    if (!inst) throw notFound('การติดตั้ง');
    try {
      return { repositories: await this.syncRepos(inst) };
    } catch (err) {
      throw new AppError(502, 'github_sync_failed', 'ดึงข้อมูลจาก GitHub ไม่สำเร็จ', { reason: (err as Error).message.slice(0, 200) });
    }
  }

  /** ถอนการเชื่อมต่อฝั่ง Friday Manage (การถอน App ออกจากองค์กรทำที่หน้า GitHub) */
  async disconnect(auth: AuthInfo, tenant: TenantInfo, id: string) {
    if (!isAdmin(tenant)) throw forbidden('ws.settings');
    if (!Id.safeParse(id).success) throw notFound('การติดตั้ง');
    return this.db.run(auth, tenant, async (tx) => {
      const [row] = await tx.delete(s.gitInstallations).where(eq(s.gitInstallations.id, id)).returning();
      if (!row) throw notFound('การติดตั้ง');
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'secu', action: 'integration.github_removed', targetType: 'git_installation', targetId: id, summary: row.accountName });
      return { removed: true };
    });
  }

  // ---------------------------------------------------------------------------
  // hooks/github
  // ---------------------------------------------------------------------------
  /** ตรวจลายเซ็น `X-Hub-Signature-256` ด้วย GITHUB_WEBHOOK_SECRET แล้วส่งเข้าคิว (ตอบ 202) */
  async receive(raw: Buffer, signature: string | undefined, event: string | undefined, delivery: string | undefined) {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) throw new AppError(503, 'github_not_configured', 'ยังไม่ได้ตั้ง GITHUB_WEBHOOK_SECRET');
    const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
    const given = Buffer.from(signature ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new AppError(401, 'invalid_signature', 'ลายเซ็นไม่ถูกต้อง');
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new AppError(400, 'invalid_json', 'ข้อมูลไม่ใช่ JSON');
    }
    if (!event) throw new AppError(400, 'missing_event', 'ไม่มี X-GitHub-Event');
    // jobId = delivery id กัน GitHub ส่งซ้ำซ้อนเข้าคิว (ขีดกลางใน UUID ใช้ได้ แต่ห้ามมี ':')
    const jobId = delivery && /^[A-Za-z0-9-]{8,64}$/.test(delivery) ? `gh-${delivery}` : undefined;
    const { jobId: id } = await this.jobs.enqueue(GIT_JOB, { event, payload }, { jobId });
    return { queued: true, jobId: id };
  }

  // ---------------------------------------------------------------------------
  // p/repositories
  // ---------------------------------------------------------------------------
  private async ctx(tx: Tx, auth: AuthInfo, tenant: TenantInfo, key: string, write: boolean) {
    const { project, access } = await this.projects.load(tx, auth, tenant, key);
    requirePerm(access, 'project.view');
    if (access.guestViewer) throw new AppError(403, 'guest_view_limited', 'Guest เห็นเฉพาะ Overview, Timeline และงานที่แชร์ให้', { allowed: ['overview', 'timeline'] });
    if (write) {
      requirePerm(access, 'project.settings');
      if (project.archivedAt || project.status === 'archived') throw new AppError(403, 'project_archived', 'โปรเจกต์ที่เก็บถาวรแก้ไขไม่ได้');
    }
    return project;
  }

  private async dto(tx: Tx, links: Array<typeof s.projectRepositories.$inferSelect>) {
    if (!links.length) return [];
    const repos = await tx.select().from(s.gitRepositories).where(inArray(s.gitRepositories.id, links.map((l) => l.repositoryId)));
    const sts = await tx.select({ id: s.workflowStatuses.id, name: s.workflowStatuses.name }).from(s.workflowStatuses).where(inArray(s.workflowStatuses.id, links.flatMap((l) => [l.onFirstCommitStatusId, l.onPrOpenStatusId, l.onMergeStatusId]).filter((x): x is string => !!x)));
    const st = (id: string | null) => (id ? { id, name: sts.find((x) => x.id === id)?.name ?? null } : null);
    return links.map((l) => ({
      id: l.id,
      repository: { id: l.repositoryId, fullName: repos.find((r) => r.id === l.repositoryId)?.fullName ?? null },
      branchPattern: l.branchPattern,
      onFirstCommitStatus: st(l.onFirstCommitStatusId),
      onPrOpenStatus: st(l.onPrOpenStatusId),
      onMergeStatus: st(l.onMergeStatusId),
      notifyOnCiFail: l.notifyOnCiFail,
    }));
  }

  async listRepos(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const project = await this.ctx(tx, auth, tenant, key, false);
      const links = await tx.select().from(s.projectRepositories).where(eq(s.projectRepositories.projectId, project.id)).orderBy(asc(s.projectRepositories.createdAt));
      const all = await tx.select().from(s.gitRepositories).orderBy(asc(s.gitRepositories.fullName));
      const linked = new Set(links.map((l) => l.repositoryId));
      return { items: await this.dto(tx, links), available: all.filter((r) => !linked.has(r.id)).map((r) => ({ id: r.id, fullName: r.fullName, defaultBranch: r.defaultBranch })) };
    });
  }

  /** สถานะที่เลือกต้องอยู่ใน Workflow ของโปรเจกต์นี้ */
  private async checkStatuses(tx: Tx, projectId: string, ids: Array<string | null | undefined>) {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    if (!want.length) return;
    const ok = await tx.select({ id: s.workflowStatuses.id }).from(s.workflowStatuses).where(and(eq(s.workflowStatuses.projectId, projectId), inArray(s.workflowStatuses.id, want)));
    if (ok.length !== want.length) throw new AppError(422, 'status_not_in_project', 'สถานะที่เลือกไม่ได้อยู่ใน Workflow ของโปรเจกต์นี้');
  }

  async linkRepo(auth: AuthInfo, tenant: TenantInfo, key: string, body: z.infer<typeof LinkRepoBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const project = await this.ctx(tx, auth, tenant, key, true);
      const [repo] = await tx.select().from(s.gitRepositories).where(eq(s.gitRepositories.id, body.repositoryId));
      if (!repo) throw new AppError(404, 'repository_not_found', 'ไม่พบ repository (ติดตั้ง GitHub App ที่ Admin Console ก่อน)');
      await this.checkStatuses(tx, project.id, [body.onFirstCommitStatusId, body.onPrOpenStatusId, body.onMergeStatusId]);
      const [dup] = await tx.select({ id: s.projectRepositories.id }).from(s.projectRepositories).where(and(eq(s.projectRepositories.projectId, project.id), eq(s.projectRepositories.repositoryId, repo.id)));
      if (dup) throw new AppError(409, 'repository_already_linked', 'โปรเจกต์นี้ผูก repository นี้อยู่แล้ว');
      const [row] = await tx.insert(s.projectRepositories).values({ workspaceId: tenant.workspaceId, projectId: project.id, repositoryId: repo.id, branchPattern: body.branchPattern ?? null, onFirstCommitStatusId: body.onFirstCommitStatusId ?? null, onPrOpenStatusId: body.onPrOpenStatusId ?? null, onMergeStatusId: body.onMergeStatusId ?? null, notifyOnCiFail: body.notifyOnCiFail }).returning();
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'data', action: 'project.repository_linked', targetType: 'project', targetId: project.id, summary: `${project.key} · ${repo.fullName}` });
      return (await this.dto(tx, [row]))[0]!;
    });
  }

  async patchRepo(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, body: z.infer<typeof PatchRepoBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const project = await this.ctx(tx, auth, tenant, key, true);
      await this.checkStatuses(tx, project.id, [body.onFirstCommitStatusId, body.onPrOpenStatusId, body.onMergeStatusId]);
      const [row] = await tx.update(s.projectRepositories).set(body).where(and(eq(s.projectRepositories.id, Id.parse(id)), eq(s.projectRepositories.projectId, project.id))).returning();
      if (!row) throw notFound('repository ของโปรเจกต์');
      return (await this.dto(tx, [row]))[0]!;
    });
  }

  async unlinkRepo(auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const project = await this.ctx(tx, auth, tenant, key, true);
      const [row] = await tx.delete(s.projectRepositories).where(and(eq(s.projectRepositories.id, Id.parse(id)), eq(s.projectRepositories.projectId, project.id))).returning();
      if (!row) throw notFound('repository ของโปรเจกต์');
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'data', action: 'project.repository_unlinked', targetType: 'project', targetId: project.id, summary: project.key });
      return { removed: true };
    });
  }

  // ---------------------------------------------------------------------------
  // i/git
  // ---------------------------------------------------------------------------
  async issueGit(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { issue } = await this.issues.loadIssue(tx, auth, tenant, key);
      const links = await tx.select().from(s.issueGitLinks).where(eq(s.issueGitLinks.issueId, issue.id)).orderBy(desc(s.issueGitLinks.createdAt));
      const commitIds = links.map((l) => l.commitId).filter((x): x is string => !!x);
      const prIds = links.map((l) => l.pullRequestId).filter((x): x is string => !!x);
      const commits = commitIds.length ? await tx.select({ c: s.gitCommits, repo: s.gitRepositories.fullName }).from(s.gitCommits).innerJoin(s.gitRepositories, eq(s.gitRepositories.id, s.gitCommits.repositoryId)).where(inArray(s.gitCommits.id, commitIds)).orderBy(desc(s.gitCommits.committedAt)) : [];
      const prs = prIds.length ? await tx.select({ p: s.pullRequests, repo: s.gitRepositories.fullName }).from(s.pullRequests).innerJoin(s.gitRepositories, eq(s.gitRepositories.id, s.pullRequests.repositoryId)).where(inArray(s.pullRequests.id, prIds)).orderBy(desc(s.pullRequests.createdAt)) : [];
      const source = (cid?: string, pid?: string) => links.find((l) => (cid ? l.commitId === cid : l.pullRequestId === pid))?.linkSource ?? null;
      return {
        commits: commits.map(({ c, repo }) => ({ sha: c.sha, shortSha: c.sha.slice(0, 7), message: c.message.split('\n')[0], author: c.authorName, committedAt: c.committedAt, url: c.url, repository: repo, linkedBy: source(c.id) })),
        pullRequests: prs.map(({ p, repo }) => ({ number: p.number, title: p.title, state: p.state, sourceBranch: p.sourceBranch, targetBranch: p.targetBranch, ciStatus: p.ciStatus, reviewStatus: p.reviewStatus, url: p.url, repository: repo, linkedBy: source(undefined, p.id) })),
      };
    });
  }
}
