import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../common/errors.js';
import { today } from '../common/dates.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { type DomainEvent, EventBus } from '../core/events.js';
import { PLAIN_RANK, rankAfter } from '../issues/rank.js';
import { type ProjectAccess, requirePerm } from '../projects/permissions.js';
import { type ProjectRow, ProjectsService } from '../projects/projects.service.js';

const s = schema;
const KEY = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})$/;
/** ครั้งละไม่เกิน 200 งานรวม Sub-task · ทำในธุรกรรมเดียว (ล้มแล้วไม่มีอะไรเปลี่ยน) */
export const MAX_MOVE = 200;
const uuid = z.uuid();

export const PreviewMoveBody = z
  .object({
    keys: z.array(z.string().trim().regex(KEY, 'Key ของงานไม่ถูกต้อง')).min(1).max(MAX_MOVE),
    targetProjectKey: z.string().trim().min(2).max(10),
    /** ประเภทงานต้นทาง → ปลายทาง · ไม่ส่ง = ใช้ที่จับคู่ตามชื่อ · ประเภทที่เลือกกำหนดตัวเลือกสถานะ */
    typeMap: z.record(uuid, uuid).default({}),
  })
  .strict();
export const MoveBody = PreviewMoveBody.extend({
  /** "<ประเภทงานต้นทาง>:<สถานะต้นทาง>" → สถานะปลายทาง · ไม่ส่ง = ใช้ที่จับคู่ตามชื่อ / หมวดเดียวกัน */
  statusMap: z.record(z.string().regex(/^[0-9a-f-]{36}:[0-9a-f-]{36}$/), uuid).default({}),
  /** Module ของปลายทางสำหรับงานระดับ Task (Sub-task ตามแม่) · null = ไม่ระบุ */
  moduleId: uuid.nullable().default(null),
  /** โปรเจกต์ปลายทางแบบส่วนตัว: เพิ่มคนที่ไม่ได้เป็นสมาชิกเป็น Member (false = เอาออกจากงาน) */
  addMembers: z.boolean().default(true),
}).strict();

type Issue = typeof s.issues.$inferSelect;
/**
 * ผู้ย้าย: ผู้ใช้ผ่าน RLS ตามปกติ · หรือทีม Friday จากสคริปต์ Ops (คนที่สองอนุมัติแล้วที่ฝั่ง Ops) ผ่าน SYSTEM_DB
 * โหมดทีม Friday ข้าม RLS จึงหาโปรเจกต์ด้วย workspace_id ของงานเสมอ · ทุก query ต่อจากนั้นอิง id ของโปรเจกต์ / งานใน Workspace นั้น
 */
type Actor = { kind: 'user'; auth: AuthInfo; tenant: TenantInfo } | { kind: 'friday_staff'; workspaceId: string; staffName: string };
const STAFF_PERMS = new Set(['issue.edit', 'issue.create', 'project.invite']);
type Status = { id: string; name: string; category: string; workflowId: string };
type TypeRow = { id: string; name: string; workflowId: string };

/** โฟลเดอร์ในปลายทางที่รับไฟล์แนบของงานที่ย้ายมา */
const movedFolder = (sourceKey: string) => `ย้ายมาจาก ${sourceKey}`;
/** ชื่อเทียบแบบไม่สนตัวพิมพ์และช่องว่างหัวท้าย */
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * ย้ายงานข้ามโปรเจกต์ (ผู้ใช้อนุมัติ storyboard 2026-11-20)
 * งานพร้อม Sub-task ได้เลขใหม่ในปลายทาง · Key เดิมจำไว้ใน issue_key_aliases · Comment ไฟล์แนบ Checklist ประวัติ ตามไปครบ
 * ของที่ผูกกับโปรเจกต์เดิม (Requirement, Screen, Milestone, Dependency กับงานที่ไม่ย้าย, ค่า Custom field ที่ไม่มีในปลายทาง) หลุดและบันทึกในประวัติ
 * สิทธิ์: แก้ไขงานในต้นทางได้ (issue.edit) และสร้างงานในปลายทางได้ (issue.create)
 */
@Injectable()
export class IssueMoveService {
  constructor(
    private readonly db: TenantDb,
    private readonly projects: ProjectsService,
    private readonly events: EventBus,
    @Inject(SYSTEM_DB) private readonly system: Db,
  ) {}

  /** ดูก่อนย้าย: เลขใหม่ การจับคู่ และสิ่งที่ตามไปไม่ได้ · ไม่เขียนข้อมูล */
  async preview(auth: AuthInfo, tenant: TenantInfo, input: z.infer<typeof PreviewMoveBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const plan = await this.plan(tx, { kind: 'user', auth, tenant }, { ...input, statusMap: {}, moduleId: null, addMembers: true });
      return this.describe(plan);
    });
  }

  async move(auth: AuthInfo, tenant: TenantInfo, input: z.infer<typeof MoveBody>) {
    const events: DomainEvent[] = [];
    const result = await this.db.run(auth, tenant, (tx) => this.execute(tx, { kind: 'user', auth, tenant }, input, events));
    await this.events.publish(events);
    return result;
  }

  /**
   * สคริปต์ Ops (Story 3) ผ่านคิวงาน: ทีม Friday ดูก่อน / ย้ายแทนลูกค้า · สิทธิ์ตรวจที่ Ops แล้ว (คนที่สองอนุมัติ)
   * ย้ายจริงใช้การจับคู่ตามชื่อ / ค่าแนะนำในหมวดเดียวกัน และเพิ่มคนที่ไม่ได้เป็นสมาชิก (เหมือนค่าเริ่มต้นของหน้าเว็บ)
   */
  forStaff(workspaceId: string, staffName: string, mode: 'preview', input: z.infer<typeof PreviewMoveBody>): Promise<ReturnType<IssueMoveService['describe']>>;
  forStaff(workspaceId: string, staffName: string, mode: 'move', input: z.infer<typeof PreviewMoveBody>): Promise<Awaited<ReturnType<IssueMoveService['apply']>>>;
  forStaff(workspaceId: string, staffName: string, mode: 'preview' | 'move', input: z.infer<typeof PreviewMoveBody>): Promise<unknown>;
  async forStaff(workspaceId: string, staffName: string, mode: 'preview' | 'move', input: z.infer<typeof PreviewMoveBody>) {
    const actor: Actor = { kind: 'friday_staff', workspaceId, staffName };
    if (mode === 'preview') return this.system.transaction(async (tx) => this.describe(await this.plan(tx, actor, { ...input, statusMap: {}, moduleId: null, addMembers: true })));
    const events: DomainEvent[] = [];
    const result = await this.system.transaction(async (tx) => {
      const plan = await this.plan(tx, actor, { ...input, statusMap: {}, moduleId: null, addMembers: true });
      const statusMap = Object.fromEntries(plan.statusRows.map((r) => [r.key, (r.to ?? r.suggested)?.id]).filter(([, v]) => v)) as Record<string, string>;
      return this.execute(tx, actor, { ...input, statusMap, moduleId: null, addMembers: true }, events);
    });
    await this.events.publish(events);
    return result;
  }

  private async execute(tx: Tx, actor: Actor, input: z.infer<typeof MoveBody>, events: DomainEvent[]) {
    const plan = await this.plan(tx, actor, input);
    const missing = [...plan.typeRows.filter((r) => !r.to), ...plan.statusRows.filter((r) => !r.to)];
    if (missing.length) throw new AppError(422, 'mapping_required', 'เลือกประเภทงานและสถานะในโปรเจกต์ปลายทางให้ครบก่อนย้าย', this.describe(plan));
    return this.apply(tx, actor, plan, input, events);
  }

  /** หาโปรเจกต์ + สิทธิ์ · ทีม Friday หาด้วย workspace_id (ข้าม RLS) และได้สิทธิ์ย้ายเต็ม */
  private async project(tx: Tx, actor: Actor, key: string) {
    if (actor.kind === 'user') return this.projects.load(tx, actor.auth, actor.tenant, key);
    const [project] = await tx.select().from(s.projects).where(and(eq(s.projects.workspaceId, actor.workspaceId), eq(s.projects.key, key.toUpperCase()), isNull(s.projects.deletedAt)));
    if (!project) throw new AppError(404, 'project_not_found', `ไม่พบโปรเจกต์ ${key.toUpperCase()}`);
    if (project.archivedAt) throw new AppError(403, 'project_archived', `โปรเจกต์ ${project.key} ถูก Archive แล้ว`);
    const access: ProjectAccess = { userId: '', role: 'admin', isOwner: false, guestViewer: false, perms: STAFF_PERMS, archived: false };
    return { project, access };
  }

  // ---------------------------------------------------------------------------
  // วางแผน (ใช้ทั้งดูก่อนและย้ายจริง)
  // ---------------------------------------------------------------------------
  private async plan(tx: Tx, actor: Actor, input: z.infer<typeof MoveBody>) {
    const keys = [...new Set(input.keys.map((k) => k.toUpperCase()))];
    const prefixes = new Set(keys.map((k) => KEY.exec(k)![1]));
    if (prefixes.size > 1) throw new AppError(400, 'invalid_reference', 'ย้ายได้ครั้งละโปรเจกต์เดียว · งานทั้งหมดต้องอยู่ในโปรเจกต์เดียวกัน');
    const { project: source, access: sourceAccess } = await this.project(tx, actor, [...prefixes][0]);
    requirePerm(sourceAccess, 'issue.edit');
    const { project: target, access: targetAccess } = await this.project(tx, actor, input.targetProjectKey);
    if (target.id === source.id) throw new AppError(400, 'same_project', 'งานอยู่ในโปรเจกต์นี้อยู่แล้ว');
    requirePerm(targetAccess, 'issue.create');
    if (targetAccess.guestViewer || sourceAccess.guestViewer) throw new AppError(403, 'forbidden', 'Guest ย้ายงานไม่ได้');

    // งานที่เลือก + งานแม่ของ Sub-task ที่เลือก + Sub-task ทุกงานของแม่ (ย้ายทั้งก้อนเสมอ)
    const numbers = keys.map((k) => Number(KEY.exec(k)![2]));
    const picked = await tx.select().from(s.issues).where(and(eq(s.issues.projectId, source.id), inArray(s.issues.number, numbers), isNull(s.issues.deletedAt)));
    const found = new Set(picked.map((i) => i.number));
    const notFound = numbers.filter((n) => !found.has(n));
    if (notFound.length) throw new AppError(404, 'not_found', `ไม่พบงาน ${notFound.map((n) => `${source.key}-${n}`).join(', ')}`, { keys: notFound.map((n) => `${source.key}-${n}`) });
    const rootIds = [...new Set(picked.map((i) => i.parentId ?? i.id))];
    const rows = await tx
      .select()
      .from(s.issues)
      .where(and(isNull(s.issues.deletedAt), or(inArray(s.issues.id, rootIds), inArray(s.issues.parentId, rootIds))))
      .orderBy(asc(s.issues.number));
    if (rows.length > MAX_MOVE) throw new AppError(422, 'too_many', `ย้ายได้ครั้งละไม่เกิน ${MAX_MOVE} งาน (รวม Sub-task) · เลือกไว้ ${rows.length} งาน`, { count: rows.length, max: MAX_MOVE });
    // แม่ก่อนลูก: trigger ตรวจว่า Sub-task อยู่โปรเจกต์เดียวกับแม่
    const issues = [...rows.filter((i) => !i.parentId), ...rows.filter((i) => i.parentId)];
    const ids = issues.map((i) => i.id);
    const pulled = issues.filter((i) => !found.has(i.number)).map((i) => `${source.key}-${i.number}`);

    // ประเภทงาน: จับคู่ตามชื่อ
    const sourceTypes: TypeRow[] = await tx.select({ id: s.issueTypes.id, name: s.issueTypes.name, workflowId: s.issueTypes.workflowId }).from(s.issueTypes).where(inArray(s.issueTypes.id, [...new Set(issues.map((i) => i.issueTypeId))]));
    const targetTypes: TypeRow[] = await tx.select({ id: s.issueTypes.id, name: s.issueTypes.name, workflowId: s.issueTypes.workflowId }).from(s.issueTypes).where(eq(s.issueTypes.projectId, target.id)).orderBy(asc(s.issueTypes.name));
    const typeRows = sourceTypes.map((from) => {
      const chosen = input.typeMap[from.id];
      if (chosen && !targetTypes.some((t) => t.id === chosen)) throw new AppError(400, 'invalid_reference', 'ประเภทงานที่เลือกไม่อยู่ในโปรเจกต์ปลายทาง');
      const to = targetTypes.find((t) => t.id === chosen) ?? targetTypes.find((t) => same(t.name, from.name)) ?? null;
      return { from, to, byName: !chosen && !!to, count: issues.filter((i) => i.issueTypeId === from.id).length };
    });

    // สถานะ: ตามชื่อใน Workflow ของประเภทปลายทาง · ไม่มีก็สถานะแรกในหมวดเดียวกัน (ต้องยืนยันในหน้าจอ)
    const statusIds = [...new Set(issues.map((i) => i.statusId))];
    const sourceStatuses: Status[] = await tx.select({ id: s.workflowStatuses.id, name: s.workflowStatuses.name, category: s.workflowStatuses.category, workflowId: s.workflowStatuses.workflowId }).from(s.workflowStatuses).where(inArray(s.workflowStatuses.id, statusIds));
    const wfIds = [...new Set(typeRows.map((r) => r.to?.workflowId).filter((x): x is string => !!x))];
    const targetStatuses: Status[] = wfIds.length
      ? await tx.select({ id: s.workflowStatuses.id, name: s.workflowStatuses.name, category: s.workflowStatuses.category, workflowId: s.workflowStatuses.workflowId }).from(s.workflowStatuses).where(inArray(s.workflowStatuses.workflowId, wfIds)).orderBy(asc(s.workflowStatuses.sort))
      : [];
    const pairs = [...new Map(issues.map((i) => [`${i.issueTypeId}:${i.statusId}`, i])).values()];
    const statusRows = pairs.map((i) => {
      const key = `${i.issueTypeId}:${i.statusId}`;
      const from = sourceStatuses.find((x) => x.id === i.statusId)!;
      const type = typeRows.find((r) => r.from.id === i.issueTypeId)!;
      const options = type.to ? targetStatuses.filter((x) => x.workflowId === type.to!.workflowId) : [];
      const chosen = input.statusMap[key];
      if (chosen && !options.some((o) => o.id === chosen)) throw new AppError(400, 'invalid_reference', 'สถานะที่เลือกไม่อยู่ใน Workflow ของประเภทงานปลายทาง');
      const byName = options.find((o) => same(o.name, from.name));
      const to = options.find((o) => o.id === chosen) ?? byName ?? null;
      const suggested = byName ?? options.find((o) => o.category === from.category) ?? null;
      return { key, type: type.from, from, to, byName: !chosen && !!byName, suggested, options, count: issues.filter((x) => `${x.issueTypeId}:${x.statusId}` === key).length };
    });

    if (input.moduleId) {
      const [m] = await tx.select({ projectId: s.modules.projectId }).from(s.modules).where(eq(s.modules.id, input.moduleId));
      if (!m || m.projectId !== target.id) throw new AppError(400, 'invalid_reference', 'Module ไม่อยู่ในโปรเจกต์ปลายทาง');
    }
    const modules = await tx.select({ id: s.modules.id, name: s.modules.name }).from(s.modules).where(eq(s.modules.projectId, target.id)).orderBy(asc(s.modules.sort));

    // Label ตามชื่อ · ไม่มีสร้างให้
    const labelRows = await tx.select({ issueId: s.issueLabels.issueId, id: s.labels.id, name: s.labels.name, color: s.labels.color }).from(s.issueLabels).innerJoin(s.labels, eq(s.labels.id, s.issueLabels.labelId)).where(inArray(s.issueLabels.issueId, ids));
    const targetLabels = await tx.select({ id: s.labels.id, name: s.labels.name }).from(s.labels).where(eq(s.labels.projectId, target.id));
    const newLabels = [...new Map(labelRows.filter((l) => !targetLabels.some((t) => same(t.name, l.name))).map((l) => [l.name.toLowerCase(), l])).values()];

    // Custom field ตามชื่อและชนิด · ไม่ตรงหลุด
    const valueRows = await tx.select({ issueId: s.issueCustomValues.issueId, fieldId: s.issueCustomValues.fieldId, value: s.issueCustomValues.value, name: s.customFields.name, fieldType: s.customFields.fieldType }).from(s.issueCustomValues).innerJoin(s.customFields, eq(s.customFields.id, s.issueCustomValues.fieldId)).where(inArray(s.issueCustomValues.issueId, ids));
    const targetFields = await tx.select({ id: s.customFields.id, name: s.customFields.name, fieldType: s.customFields.fieldType }).from(s.customFields).where(eq(s.customFields.projectId, target.id));
    const fieldMap = new Map(valueRows.map((v) => [v.fieldId, targetFields.find((t) => same(t.name, v.name) && t.fieldType === v.fieldType)?.id ?? null]));
    const droppedFields = [...new Set(valueRows.filter((v) => !fieldMap.get(v.fieldId)).map((v) => v.name))];

    // ของที่ผูกกับโปรเจกต์เดิม
    const reqs = await tx.select({ issueId: s.issueRequirements.issueId, code: s.requirements.code }).from(s.issueRequirements).innerJoin(s.requirements, eq(s.requirements.id, s.issueRequirements.requirementId)).where(inArray(s.issueRequirements.issueId, ids));
    const scrs = await tx.select({ issueId: s.issueScreens.issueId, code: s.screens.code }).from(s.issueScreens).innerJoin(s.screens, eq(s.screens.id, s.issueScreens.screenId)).where(inArray(s.issueScreens.issueId, ids));
    const miles = await tx.select({ issueId: s.milestoneIssues.issueId, name: s.milestones.name }).from(s.milestoneIssues).innerJoin(s.milestones, eq(s.milestones.id, s.milestoneIssues.milestoneId)).where(inArray(s.milestoneIssues.issueId, ids));
    const deps = await tx.select().from(s.issueDependencies).where(or(inArray(s.issueDependencies.predecessorId, ids), inArray(s.issueDependencies.successorId, ids)));
    const brokenDeps = deps.filter((d) => !ids.includes(d.predecessorId) || !ids.includes(d.successorId));
    const otherIds = brokenDeps.map((d) => (ids.includes(d.predecessorId) ? d.successorId : d.predecessorId));
    const others = otherIds.length ? await tx.select({ id: s.issues.id, number: s.issues.number, projectId: s.issues.projectId }).from(s.issues).where(inArray(s.issues.id, otherIds)) : [];
    const dueRequests = await tx.select({ id: s.dueChangeRequests.id, issueId: s.dueChangeRequests.issueId, requesterId: s.dueChangeRequests.requesterId }).from(s.dueChangeRequests).where(and(inArray(s.dueChangeRequests.issueId, ids), eq(s.dueChangeRequests.status, 'pending')));

    // คน: โปรเจกต์ปลายทางแบบส่วนตัวเห็นได้เฉพาะสมาชิก
    const watchers = await tx.select().from(s.issueWatchers).where(inArray(s.issueWatchers.issueId, ids));
    const assignees = await tx.select().from(s.issueAssignees).where(inArray(s.issueAssignees.issueId, ids));
    const people = new Set<string>();
    for (const i of issues) [...i.baIds, i.saId, ...i.reviewerIds, i.testerId].forEach((u) => u && people.add(u));
    assignees.forEach((a) => people.add(a.userId));
    watchers.forEach((w) => people.add(w.userId));
    let outsiders: { id: string; name: string }[] = [];
    if (target.visibility === 'private' && people.size) {
      const members = await tx.select({ userId: s.projectMembers.userId }).from(s.projectMembers).where(eq(s.projectMembers.projectId, target.id));
      const inside = new Set(members.map((m) => m.userId));
      const ids2 = [...people].filter((u) => !inside.has(u));
      outsiders = ids2.length ? (await tx.select({ id: s.users.id, name: s.users.displayName }).from(s.users).where(inArray(s.users.id, ids2))).sort((a, b) => a.name.localeCompare(b.name)) : [];
    }

    // ไฟล์: ย้ายเฉพาะไฟล์ที่แนบกับงาน / Comment / ผลทดสอบของงานที่ย้ายเท่านั้น · ไฟล์ที่ใช้ร่วมกับงานอื่นอยู่ที่เดิม
    const files = await this.files(tx, source, ids);
    const typeName = new Map(sourceTypes.map((t) => [t.id, t.name]));

    return {
      source, target, sourceAccess, targetAccess, issues, ids, pulled, typeRows, statusRows, targetTypes, modules, labelRows, targetLabels, newLabels,
      valueRows, fieldMap, droppedFields, reqs, scrs, miles, brokenDeps, others, dueRequests, outsiders, files, assignees, watchers, typeName,
    };
  }

  private async files(tx: Tx, source: ProjectRow, ids: string[]) {
    const comments = await tx.select({ id: s.comments.id }).from(s.comments).where(inArray(s.comments.issueId, ids));
    const runs = await tx.select({ id: s.testRuns.id }).from(s.testRuns).where(inArray(s.testRuns.issueId, ids));
    const targets = [...ids, ...comments.map((c) => c.id), ...runs.map((r) => r.id)];
    const attached = await tx.select({ fileId: s.fileAttachments.fileId }).from(s.fileAttachments).where(inArray(s.fileAttachments.targetId, targets));
    const fileIds = [...new Set(attached.map((a) => a.fileId))];
    if (!fileIds.length) return { move: [] as string[], keep: 0 };
    const all = await tx.select({ fileId: s.fileAttachments.fileId, targetId: s.fileAttachments.targetId }).from(s.fileAttachments).where(inArray(s.fileAttachments.fileId, fileIds));
    const inside = new Set(targets);
    const own = await tx.select({ id: s.files.id }).from(s.files).where(and(inArray(s.files.id, fileIds), eq(s.files.projectId, source.id)));
    const move = own.map((f) => f.id).filter((id) => all.filter((a) => a.fileId === id).every((a) => inside.has(a.targetId)));
    return { move, keep: fileIds.length - move.length };
  }

  /** สิ่งที่หน้าจอแสดง (ดูก่อนย้าย / ตอบกลับเมื่อจับคู่ไม่ครบ) */
  private describe(p: Awaited<ReturnType<IssueMoveService['plan']>>) {
    let next = p.target.issueSeq;
    const keyOf = (i: Issue) => `${p.source.key}-${i.number}`;
    const otherKey = (id: string) => {
      const o = p.others.find((x) => x.id === id);
      return o ? (o.projectId === p.source.id ? `${p.source.key}-${o.number}` : `#${o.number}`) : '?';
    };
    const canInvite = p.targetAccess.perms.has('project.invite');
    return {
      source: { key: p.source.key, name: p.source.name },
      target: { key: p.target.key, name: p.target.name, visibility: p.target.visibility },
      issues: p.issues.map((i) => ({ key: keyOf(i), newKey: `${p.target.key}-${++next}`, title: i.title, subtask: !!i.parentId })),
      count: p.issues.length,
      subtasks: p.issues.filter((i) => i.parentId).length,
      pulled: p.pulled,
      types: p.typeRows.map((r) => ({ from: { id: r.from.id, name: r.from.name }, to: r.to ? { id: r.to.id, name: r.to.name } : null, byName: r.byName, count: r.count })),
      typeOptions: p.targetTypes.map((t) => ({ id: t.id, name: t.name })),
      statuses: p.statusRows.map((r) => ({
        key: r.key, typeName: r.type.name, from: { id: r.from.id, name: r.from.name, category: r.from.category },
        to: r.to ? { id: r.to.id, name: r.to.name } : null, byName: r.byName, suggested: r.suggested ? { id: r.suggested.id, name: r.suggested.name } : null,
        options: r.options.map((o) => ({ id: o.id, name: o.name, category: o.category })), count: r.count,
      })),
      modules: p.modules,
      labels: { create: p.newLabels.map((l) => l.name) },
      dropped: {
        requirements: [...new Set(p.reqs.map((r) => r.code))],
        screens: [...new Set(p.scrs.map((r) => r.code))],
        milestones: [...new Set(p.miles.map((r) => r.name))],
        customFields: p.droppedFields,
        dependencies: p.brokenDeps.map((d) => (p.ids.includes(d.predecessorId) ? { issue: keyOf(p.issues.find((i) => i.id === d.predecessorId)!), other: otherKey(d.successorId), side: 'successor' } : { issue: keyOf(p.issues.find((i) => i.id === d.successorId)!), other: otherKey(d.predecessorId), side: 'predecessor' })),
        dueRequests: p.dueRequests.length,
      },
      people: { outside: p.outsiders, canInvite },
      files: { move: p.files.move.length, keep: p.files.keep, folder: movedFolder(p.source.key) },
    };
  }

  // ---------------------------------------------------------------------------
  // ย้ายจริง
  // ---------------------------------------------------------------------------
  private async apply(tx: Tx, actor: Actor, p: Awaited<ReturnType<IssueMoveService['plan']>>, input: z.infer<typeof MoveBody>, events: DomainEvent[]) {
    const { source, target } = p;
    const ws = actor.kind === 'user' ? actor.tenant.workspaceId : actor.workspaceId;
    // ทีม Friday: ไม่มีผู้ใช้ใน Workspace เป็นผู้ทำ · ประวัติ / Audit ติดป้าย friday_staff พร้อมชื่อพนักงาน
    const actorId = actor.kind === 'user' ? actor.auth.userId : null;
    const actorKind = actor.kind === 'user' ? ('user' as const) : ('friday_staff' as const);
    const by = actor.kind === 'friday_staff' ? `[Friday · ${actor.staffName}] ` : '';
    const typeTo = new Map(p.typeRows.map((r) => [r.from.id, r.to!]));
    const statusTo = new Map(p.statusRows.map((r) => [r.key, r.to!]));
    const statusCat = new Map(p.statusRows.map((r) => [r.key, r.from.category]));
    const targetStatusCat = new Map(p.statusRows.flatMap((r) => r.options.map((o) => [o.id, o.category] as const)));

    // คนที่ไม่ได้เป็นสมาชิกโปรเจกต์ส่วนตัว: เพิ่ม (ต้องมีสิทธิ์เชิญ) หรือเอาออกจากงาน
    const addMembers = input.addMembers && p.targetAccess.perms.has('project.invite');
    const removed = new Set<string>();
    if (p.outsiders.length) {
      if (addMembers) {
        await tx.insert(s.projectMembers).values(p.outsiders.map((u) => ({ workspaceId: ws, projectId: target.id, userId: u.id, role: 'member' as const }))).onConflictDoNothing();
        events.push(...p.outsiders.map((u) => ({ type: 'member.joined' as const, workspaceId: ws, projectId: target.id, actorId, data: { projectKey: target.key, userId: u.id, role: 'member' }, at: new Date() })));
      } else p.outsiders.forEach((u) => removed.add(u.id));
    }

    // Label ที่ปลายทางยังไม่มี
    const labelTo = new Map<string, string>();
    for (const l of p.targetLabels) labelTo.set(l.name.toLowerCase(), l.id);
    for (const l of p.newLabels) {
      const [row] = await tx.insert(s.labels).values({ workspaceId: ws, projectId: target.id, name: l.name, color: l.color }).returning({ id: s.labels.id });
      labelTo.set(l.name.toLowerCase(), row.id);
    }

    let rank = await this.rankAtEnd(tx, target.id);
    const newKeys = new Map<string, string>();
    const day = today();
    for (const i of p.issues) {
      const [{ n }] = await tx.update(s.projects).set({ issueSeq: sql`${s.projects.issueSeq} + 1` }).where(eq(s.projects.id, target.id)).returning({ n: s.projects.issueSeq });
      const pair = `${i.issueTypeId}:${i.statusId}`;
      const status = statusTo.get(pair)!;
      const from = statusCat.get(pair)!;
      const to = targetStatusCat.get(status.id)!;
      const set: Partial<typeof s.issues.$inferInsert> = {
        projectId: target.id, number: n, issueTypeId: typeTo.get(i.issueTypeId)!.id, statusId: status.id,
        // Sub-task ใช้ Module เดียวกับแม่ · กลุ่มงานและ Sprint เป็นของโปรเจกต์เดิม จึงล้าง
        moduleId: input.moduleId, phaseId: null, sprintId: null, excelRowNo: null, rank,
        version: sql`${s.issues.version} + 1` as unknown as number, updatedAt: new Date(),
      };
      // หมวดสถานะเปลี่ยน (เช่น In progress → To do) ตั้งวันเสร็จจริงตามกติกาเดียวกับการเปลี่ยนสถานะ
      if (to !== from) {
        if (to === 'done') Object.assign(set, { actualEnd: day, completedAt: new Date(), actualStart: i.actualStart ?? day });
        else if (to === 'cancelled') Object.assign(set, { actualEnd: null, completedAt: new Date() });
        else Object.assign(set, { actualEnd: null, completedAt: null, ...(to !== 'todo' && !i.actualStart ? { actualStart: day } : {}) });
      }
      if (removed.size) {
        const keep = (u: string | null) => (u && removed.has(u) ? null : u);
        const baIds = i.baIds.filter((u) => !removed.has(u));
        const reviewerIds = i.reviewerIds.filter((u) => !removed.has(u));
        Object.assign(set, { baIds, baId: baIds[0] ?? null, reviewerIds, reviewerId: reviewerIds[0] ?? null, saId: keep(i.saId), testerId: keep(i.testerId) });
      }
      await tx.update(s.issues).set(set).where(eq(s.issues.id, i.id));
      rank = rankAfter(rank);
      const oldKey = `${source.key}-${i.number}`;
      const newKey = `${target.key}-${n}`;
      newKeys.set(i.id, newKey);
      await tx.insert(s.issueKeyAliases).values({ workspaceId: ws, projectId: source.id, number: i.number, issueId: i.id });
      // ประวัติเดิมของงานตามไปอยู่ในโปรเจกต์ใหม่
      await tx.update(s.activities).set({ projectId: target.id }).where(eq(s.activities.issueId, i.id));
    }

    const ids = p.ids;
    if (removed.size) {
      await tx.delete(s.issueAssignees).where(and(inArray(s.issueAssignees.issueId, ids), inArray(s.issueAssignees.userId, [...removed])));
      await tx.delete(s.issueWatchers).where(and(inArray(s.issueWatchers.issueId, ids), inArray(s.issueWatchers.userId, [...removed])));
    }
    // Label / Custom field ของปลายทาง
    for (const l of p.labelRows) {
      const to = labelTo.get(l.name.toLowerCase())!;
      await tx.delete(s.issueLabels).where(and(eq(s.issueLabels.issueId, l.issueId), eq(s.issueLabels.labelId, l.id)));
      await tx.insert(s.issueLabels).values({ workspaceId: ws, issueId: l.issueId, labelId: to }).onConflictDoNothing();
    }
    for (const v of p.valueRows) {
      await tx.delete(s.issueCustomValues).where(and(eq(s.issueCustomValues.issueId, v.issueId), eq(s.issueCustomValues.fieldId, v.fieldId)));
      const to = p.fieldMap.get(v.fieldId);
      if (to) await tx.insert(s.issueCustomValues).values({ workspaceId: ws, issueId: v.issueId, fieldId: to, value: v.value }).onConflictDoNothing();
    }
    // ของที่ผูกกับโปรเจกต์เดิมหลุด
    await tx.delete(s.issueRequirements).where(inArray(s.issueRequirements.issueId, ids));
    await tx.delete(s.issueScreens).where(inArray(s.issueScreens.issueId, ids));
    await tx.delete(s.milestoneIssues).where(inArray(s.milestoneIssues.issueId, ids));
    for (const d of p.brokenDeps) await tx.delete(s.issueDependencies).where(and(eq(s.issueDependencies.predecessorId, d.predecessorId), eq(s.issueDependencies.successorId, d.successorId)));
    if (p.dueRequests.length) {
      await tx.update(s.dueChangeRequests).set({ status: 'cancelled', decisionNote: `ยกเลิกอัตโนมัติ: งานย้ายไปโปรเจกต์ ${target.key}` }).where(inArray(s.dueChangeRequests.id, p.dueRequests.map((r) => r.id)));
    }
    // ไฟล์ที่ใช้เฉพาะงานที่ย้าย: ไปโฟลเดอร์ "ย้ายมาจาก <Key>" ของปลายทาง
    if (p.files.move.length) {
      const name = movedFolder(source.key);
      const [folder] = await tx.select({ id: s.folders.id }).from(s.folders).where(and(eq(s.folders.projectId, target.id), isNull(s.folders.parentId), eq(s.folders.name, name)));
      const folderId = folder?.id ?? (await tx.insert(s.folders).values({ workspaceId: ws, projectId: target.id, name }).returning({ id: s.folders.id }))[0].id;
      await tx.update(s.files).set({ projectId: target.id, folderId }).where(inArray(s.files.id, p.files.move));
    }

    // ประวัติของแต่ละงาน + Audit + เหตุการณ์
    const describe = this.describe(p);
    const dropped = describe.dropped;
    for (const i of p.issues) {
      const oldKey = `${source.key}-${i.number}`;
      const lost = {
        requirements: [...new Set(p.reqs.filter((r) => r.issueId === i.id).map((r) => r.code))],
        screens: [...new Set(p.scrs.filter((r) => r.issueId === i.id).map((r) => r.code))],
        milestones: [...new Set(p.miles.filter((r) => r.issueId === i.id).map((r) => r.name))],
        customFields: [...new Set(p.valueRows.filter((v) => v.issueId === i.id && !p.fieldMap.get(v.fieldId)).map((v) => v.name))],
        dependencies: dropped.dependencies.filter((d) => d.issue === oldKey).map((d) => d.other),
      };
      await tx.insert(s.activities).values({
        workspaceId: ws, projectId: target.id, issueId: i.id, actorId, actorKind, verb: 'moved', field: 'projectId',
        oldValue: { key: oldKey, projectKey: source.key, projectName: source.name },
        newValue: { key: newKeys.get(i.id), projectKey: target.key, projectName: target.name, withSubtasks: !i.parentId ? p.issues.filter((x) => x.parentId === i.id).length : 0, dropped: lost },
      });
      events.push({ type: 'issue.moved', workspaceId: ws, projectId: target.id, issueId: i.id, actorId, at: new Date(),
        data: { issueKey: newKeys.get(i.id), oldKey, title: i.title, fromProjectId: source.id, fromProjectKey: source.key, parentId: i.parentId } });
    }
    const roots = p.issues.filter((i) => !i.parentId);
    await tx.insert(s.auditLogs).values(roots.map((i) => ({
      workspaceId: ws, actorId, actorKind, category: 'data' as const, action: 'issue.moved', targetType: 'issue', targetId: i.id,
      summary: `${by}ย้าย ${source.key}-${i.number} → ${newKeys.get(i.id)}${p.issues.some((x) => x.parentId === i.id) ? ` พร้อม Sub-task ${p.issues.filter((x) => x.parentId === i.id).length} งาน` : ''}`,
    })));
    return {
      moved: p.issues.map((i) => ({ from: `${source.key}-${i.number}`, to: newKeys.get(i.id)! })),
      target: { key: target.key, name: target.name },
      key: newKeys.get((p.issues.find((i) => !i.parentId) ?? p.issues[0]).id)!,
      membersAdded: addMembers ? p.outsiders.length : 0,
      removedPeople: removed.size,
      filesMoved: p.files.move.length,
      dropped,
    };
  }

  /** ต่อท้ายลำดับของปลายทาง (เหมือนสร้างงานใหม่) */
  private async rankAtEnd(tx: Tx, projectId: string) {
    const [last] = await tx
      .select({ rank: s.issues.rank })
      .from(s.issues)
      .where(and(eq(s.issues.projectId, projectId), sql`${s.issues.rank} ~ ${PLAIN_RANK.source}`))
      .orderBy(sql`${s.issues.rank} collate "C" desc`)
      .limit(1);
    return rankAfter(last?.rank ?? null);
  }
}

