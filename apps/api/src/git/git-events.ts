import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { today } from '../common/dates.js';
import { EventBus } from '../core/events.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { Notifier } from '../notifications/notifier.js';

const s = schema;
const KEY_RE = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})(?![A-Za-z0-9])/g;
/** ลำดับการเดินหน้าของงานจาก Git · blocked / cancelled = null (คนตัดสินใจไว้แล้ว Git ไม่ย้ายออก และไม่ย้ายเข้า) */
const RANK: Record<string, number | null> = { todo: 0, in_progress: 1, review: 2, done: 3, blocked: null, cancelled: null };

/** Issue key ที่พบในข้อความ (ไม่สนตัวพิมพ์ · ตัดซ้ำ) เช่น "feature/dp-39-login" → DP-39 */
export function issueKeysIn(text: string | null | undefined): Array<{ key: string; n: number }> {
  const out = new Map<string, { key: string; n: number }>();
  for (const m of (text ?? '').matchAll(KEY_RE)) out.set(`${m[1]!.toUpperCase()}-${m[2]}`, { key: m[1]!.toUpperCase(), n: Number(m[2]) });
  return [...out.values()];
}

/** branch pattern แบบ glob ธรรมดา (`*` = อะไรก็ได้) */
const globToRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

type Payload = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Connected {
  link: typeof s.projectRepositories.$inferSelect;
  projectKey: string;
  projectName: string;
  ownerId: string;
}

/** ประมวลผล Event จาก GitHub (หลังตรวจลายเซ็นแล้ว) · idempotent: ส่งซ้ำได้ผลเท่าเดิม */
@Injectable()
export class GitEventsService {
  private readonly log = new Logger('GitEvents');

  constructor(
    @Inject(SYSTEM_DB) private readonly db: Db,
    private readonly events: EventBus,
    private readonly notifier: Notifier,
  ) {}

  async handle(event: string, p: Payload) {
    switch (event) {
      case 'installation':
        return this.installation(p);
      case 'installation_repositories':
        return this.installationRepos(p);
      case 'push':
        return this.push(p);
      case 'pull_request':
        return this.pullRequest(p);
      case 'pull_request_review':
        return this.review(p);
      case 'check_run':
      case 'check_suite':
      case 'workflow_run':
        return this.ci(event, p);
      default:
        return; // ping และ Event อื่นที่ไม่ใช้
    }
  }

  // ---------------------------------------------------------------------------
  // ติดตั้ง / repository
  // ---------------------------------------------------------------------------
  private async installationRow(p: Payload) {
    const id = String(p.installation?.id ?? '');
    if (!id) return null;
    const [row] = await this.db.select().from(s.gitInstallations).where(and(eq(s.gitInstallations.provider, 'github'), eq(s.gitInstallations.externalInstallationId, id)));
    return row ?? null;
  }

  private async installation(p: Payload) {
    const inst = await this.installationRow(p);
    if (!inst) return;
    if (p.action === 'deleted') await this.db.delete(s.gitInstallations).where(eq(s.gitInstallations.id, inst.id));
    else if (p.action === 'suspend') await this.db.update(s.gitInstallations).set({ status: 'suspended' }).where(eq(s.gitInstallations.id, inst.id));
    else if (p.action === 'unsuspend') await this.db.update(s.gitInstallations).set({ status: 'active' }).where(eq(s.gitInstallations.id, inst.id));
  }

  private async installationRepos(p: Payload) {
    const inst = await this.installationRow(p);
    if (!inst) return;
    for (const r of (p.repositories_added ?? []) as Array<{ full_name: string }>) {
      await this.db.insert(s.gitRepositories).values({ workspaceId: inst.workspaceId, installationId: inst.id, fullName: r.full_name }).onConflictDoNothing();
    }
    const removed = ((p.repositories_removed ?? []) as Array<{ full_name: string }>).map((r) => r.full_name);
    if (removed.length) await this.db.delete(s.gitRepositories).where(and(eq(s.gitRepositories.installationId, inst.id), inArray(s.gitRepositories.fullName, removed)));
  }

  private async repo(p: Payload) {
    const inst = await this.installationRow(p);
    const full = p.repository?.full_name as string | undefined;
    if (!inst || !full || inst.status !== 'active') return null;
    const [repo] = await this.db.select().from(s.gitRepositories).where(and(eq(s.gitRepositories.installationId, inst.id), eq(s.gitRepositories.fullName, full)));
    return repo ?? null;
  }

  /** โปรเจกต์ที่ผูกกับ repository นี้ (กรอง branch pattern แล้ว) */
  private async connected(repoId: string, branch: string | null): Promise<Connected[]> {
    const rows = await this.db
      .select({ link: s.projectRepositories, key: s.projects.key, name: s.projects.name, owner: s.projects.ownerUserId })
      .from(s.projectRepositories)
      .innerJoin(s.projects, eq(s.projects.id, s.projectRepositories.projectId))
      .where(and(eq(s.projectRepositories.repositoryId, repoId), isNull(s.projects.deletedAt), isNull(s.projects.archivedAt)));
    return rows
      .filter((r) => !r.link.branchPattern || branch === null || globToRe(r.link.branchPattern).test(branch))
      .map((r) => ({ link: r.link, projectKey: r.key, projectName: r.name, ownerId: r.owner }));
  }

  /** Issue ที่อ้างถึงในข้อความ เฉพาะโปรเจกต์ที่ผูกกับ repository นี้ */
  private async issuesFor(conns: Connected[], texts: string[]) {
    const keys = [...new Map(texts.flatMap(issueKeysIn).map((k) => [`${k.key}-${k.n}`, k])).values()];
    const out: Array<{ issue: typeof s.issues.$inferSelect; conn: Connected }> = [];
    for (const k of keys) {
      const conn = conns.find((c) => c.projectKey === k.key);
      if (!conn) continue;
      const [issue] = await this.db.select().from(s.issues).where(and(eq(s.issues.projectId, conn.link.projectId), eq(s.issues.number, k.n), isNull(s.issues.deletedAt)));
      if (issue) out.push({ issue, conn });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // push → commit
  // ---------------------------------------------------------------------------
  private async push(p: Payload) {
    const repo = await this.repo(p);
    if (!repo || !String(p.ref ?? '').startsWith('refs/heads/') || p.deleted) return;
    const branch = String(p.ref).slice('refs/heads/'.length);
    const conns = await this.connected(repo.id, branch);
    if (!conns.length) return;
    for (const c of (p.commits ?? []) as Array<Payload>) {
      const [commit] = await this.db
        .insert(s.gitCommits)
        .values({ workspaceId: repo.workspaceId, repositoryId: repo.id, sha: c.id, message: String(c.message ?? '').slice(0, 5000), authorName: c.author?.name ?? c.author?.username ?? null, committedAt: new Date(c.timestamp ?? Date.now()), url: c.url ?? `https://github.com/${repo.fullName}/commit/${c.id}` })
        .onConflictDoUpdate({ target: [s.gitCommits.repositoryId, s.gitCommits.sha], set: { message: String(c.message ?? '').slice(0, 5000) } })
        .returning({ id: s.gitCommits.id });
      const fromMessage = await this.issuesFor(conns, [String(c.message ?? '')]);
      const fromBranch = await this.issuesFor(conns, [branch]);
      const all = new Map([...fromBranch, ...fromMessage].map((x) => [x.issue.id, { ...x, source: fromMessage.some((m) => m.issue.id === x.issue.id) ? ('message' as const) : ('branch' as const) }]));
      for (const { issue, conn, source } of all.values()) {
        const [ins] = await this.db.insert(s.issueGitLinks).values({ workspaceId: repo.workspaceId, issueId: issue.id, commitId: commit.id, linkSource: source }).onConflictDoNothing().returning({ id: s.issueGitLinks.id });
        if (!ins) continue;
        // commit แรกที่ผูกกับงาน → ย้ายสถานะตามกฎของโปรเจกต์
        const [n] = await this.db.select({ n: sql<number>`count(*)::int` }).from(s.issueGitLinks).where(and(eq(s.issueGitLinks.issueId, issue.id), sql`${s.issueGitLinks.commitId} is not null`));
        if ((n?.n ?? 0) === 1) await this.moveStatus(issue, conn.link.onFirstCommitStatusId, repo.fullName);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // pull request
  // ---------------------------------------------------------------------------
  private async pullRequest(p: Payload) {
    const pr = p.pull_request as Payload | undefined;
    const repo = await this.repo(p);
    if (!pr || !repo) return;
    const state = pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft ? 'draft' : 'open';
    const branch = String(pr.head?.ref ?? '');
    const values = { title: String(pr.title ?? '').slice(0, 500), state, sourceBranch: branch, targetBranch: String(pr.base?.ref ?? ''), url: String(pr.html_url ?? '') } as const;
    const [row] = await this.db
      .insert(s.pullRequests)
      .values({ workspaceId: repo.workspaceId, repositoryId: repo.id, number: Number(pr.number), ...values, ...(p.action === 'synchronize' ? { ciStatus: null } : {}) })
      .onConflictDoUpdate({ target: [s.pullRequests.repositoryId, s.pullRequests.number], set: { ...values, ...(p.action === 'synchronize' ? { ciStatus: null } : {}) } })
      .returning();
    const conns = await this.connected(repo.id, branch);
    if (!conns.length) return;
    const fromTitle = await this.issuesFor(conns, [values.title]);
    const fromBranch = await this.issuesFor(conns, [branch]);
    const all = new Map([...fromBranch, ...fromTitle].map((x) => [x.issue.id, { ...x, source: fromTitle.some((m) => m.issue.id === x.issue.id) ? ('title' as const) : ('branch' as const) }]));
    for (const { issue, conn, source } of all.values()) {
      await this.db.insert(s.issueGitLinks).values({ workspaceId: repo.workspaceId, issueId: issue.id, pullRequestId: row.id, linkSource: source }).onConflictDoNothing();
      if (state === 'open' && ['opened', 'reopened', 'ready_for_review'].includes(String(p.action))) await this.moveStatus(issue, conn.link.onPrOpenStatusId, repo.fullName);
      if (state === 'merged') await this.moveStatus(issue, conn.link.onMergeStatusId, repo.fullName);
    }
  }

  private async review(p: Payload) {
    const repo = await this.repo(p);
    const state = String(p.review?.state ?? '').toLowerCase();
    if (!repo || p.action !== 'submitted' || !['approved', 'changes_requested'].includes(state)) return;
    await this.db.update(s.pullRequests).set({ reviewStatus: state }).where(and(eq(s.pullRequests.repositoryId, repo.id), eq(s.pullRequests.number, Number(p.pull_request?.number))));
  }

  // ---------------------------------------------------------------------------
  // CI
  // ---------------------------------------------------------------------------
  private async ci(event: string, p: Payload) {
    const obj = (p[event] ?? {}) as Payload;
    if (p.action !== 'completed') return;
    const repo = await this.repo(p);
    if (!repo) return;
    const conclusion = String(obj.conclusion ?? '');
    const status = conclusion === 'success' ? 'success' : ['failure', 'timed_out', 'startup_failure', 'action_required'].includes(conclusion) ? 'failure' : null;
    if (!status) return;
    const sha = String(obj.head_sha ?? '');
    for (const ref of (obj.pull_requests ?? []) as Array<{ number: number }>) {
      const [pr] = await this.db.update(s.pullRequests).set({ ciStatus: status }).where(and(eq(s.pullRequests.repositoryId, repo.id), eq(s.pullRequests.number, ref.number))).returning();
      if (!pr || status !== 'failure') continue;
      const conns = await this.connected(repo.id, pr.sourceBranch);
      const linked = await this.db
        .select({ issue: s.issues })
        .from(s.issueGitLinks)
        .innerJoin(s.issues, eq(s.issues.id, s.issueGitLinks.issueId))
        .where(eq(s.issueGitLinks.pullRequestId, pr.id));
      for (const { issue } of linked) {
        const conn = conns.find((c) => c.link.projectId === issue.projectId);
        if (!conn?.link.notifyOnCiFail) continue;
        const assignees = (await this.db.select({ u: s.issueAssignees.userId }).from(s.issueAssignees).where(eq(s.issueAssignees.issueId, issue.id)).orderBy(asc(s.issueAssignees.sort))).map((a) => a.u);
        const key = `${conn.projectKey}-${issue.number}`;
        const data = { issueKey: key, title: issue.title, prNumber: pr.number, prTitle: pr.title, prUrl: pr.url, repository: repo.fullName, sha, check: String(obj.name ?? obj.display_title ?? event) };
        await this.notifier.notify({
          workspaceId: repo.workspaceId,
          recipientIds: assignees.length ? assignees : [conn.ownerId],
          eventType: 'ci.failed',
          actorId: null,
          projectId: issue.projectId,
          issueId: issue.id,
          payload: { projectKey: conn.projectKey, projectName: conn.projectName, issueTitle: issue.title, ...data },
          reason: assignees.length ? 'คุณรับผิดชอบงานที่ผูกกับ PR ที่ CI ล้มเหลว' : 'คุณเป็น PM ของงานที่ผูกกับ PR ที่ CI ล้มเหลว',
          dedupeKey: `ci:${repo.id}:${pr.number}:${sha}`,
        });
        await this.events.publish({ type: 'ci.failed', workspaceId: repo.workspaceId, projectId: issue.projectId, issueId: issue.id, actorId: null, data, at: new Date() });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // ย้ายสถานะตามกฎของโปรเจกต์
  // ---------------------------------------------------------------------------
  /** ย้ายไปข้างหน้าเท่านั้น (todo → in_progress → review → done) · งานที่อยู่ไกลกว่า สถานะเดียวกัน หรือติดอยู่ / ยกเลิกไม่ถูกแตะ */
  private async moveStatus(issue: typeof s.issues.$inferSelect, targetId: string | null, repoName: string) {
    if (!targetId || targetId === issue.statusId) return;
    const sts = await this.db.select().from(s.workflowStatuses).where(inArray(s.workflowStatuses.id, [targetId, issue.statusId]));
    const target = sts.find((x) => x.id === targetId);
    const current = sts.find((x) => x.id === issue.statusId);
    if (!target || !current || target.workflowId !== current.workflowId) return;
    const from = RANK[current.category] ?? null;
    const to = RANK[target.category] ?? null;
    if (from === null || to === null || to < from) return;
    const day = today();
    const set: Partial<typeof s.issues.$inferInsert> = { statusId: target.id };
    if (target.category !== 'todo' && !issue.actualStart) set.actualStart = day;
    if (target.category === 'done') Object.assign(set, { actualEnd: day, completedAt: new Date() });
    const [updated] = await this.db.update(s.issues).set(set).where(and(eq(s.issues.id, issue.id), eq(s.issues.statusId, issue.statusId))).returning();
    if (!updated) return; // มีคนย้ายไปแล้วระหว่างนี้
    await this.db.insert(s.activities).values({ workspaceId: issue.workspaceId, projectId: issue.projectId, issueId: issue.id, actorKind: 'git', verb: 'updated', field: 'statusId', oldValue: current.id, newValue: target.id });
    const [proj] = await this.db.select({ key: s.projects.key }).from(s.projects).where(eq(s.projects.id, issue.projectId));
    await this.events.publish({
      type: 'issue.status_changed',
      workspaceId: issue.workspaceId,
      projectId: issue.projectId,
      issueId: issue.id,
      actorId: null,
      data: { issueKey: `${proj?.key}-${issue.number}`, title: issue.title, from: { id: current.id, name: current.name }, to: { id: target.id, name: target.name }, via: 'git', repository: repoName },
      at: new Date(),
    });
    this.log.log(`${proj?.key}-${issue.number}: ${current.name} → ${target.name} (git)`);
  }
}
