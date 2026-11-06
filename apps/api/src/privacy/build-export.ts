import { readFile } from 'node:fs/promises';
import { schema, type Tx } from '@friday/db';
import { asc, eq, inArray } from 'drizzle-orm';
import { zipSync, strToU8 } from 'fflate';
import { LocalStorage } from '../files/storage.js';

const s = schema;
/** ไฟล์แนบที่ใส่ใน zip: ต่อไฟล์ ≤ 25 MB และรวม ≤ 200 MB · เกินจากนี้ระบุใน manifest ให้ดาวน์โหลดแยก */
const MAX_FILE = 25 * 1024 * 1024;
const MAX_TOTAL = 200 * 1024 * 1024;

const json = (v: unknown) => strToU8(JSON.stringify(v, null, 2));
/** CSV ที่เปิดใน Excel ได้ภาษาไทย (BOM) และกัน CSV injection */
function csv(rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) => {
    let t = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return strToU8(`﻿${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`);
}
const safe = (name: string) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file';

/**
 * Export ทั้ง Workspace เป็น zip (JSON + CSV + ไฟล์แนบ) · เรียกภายใต้ RLS ของผู้ขอ (Owner / Admin เห็นทุกโปรเจกต์)
 * ไม่รวมความลับ: รหัสผ่าน, token, secret ของช่องทาง/Webhook, API token
 */
export async function buildWorkspaceZip(tx: Tx, workspaceId: string, opts: { storage?: LocalStorage } = {}) {
  const storage = opts.storage ?? new LocalStorage();
  const out: Record<string, Uint8Array> = {};

  const [ws] = await tx.select().from(s.workspaces).where(eq(s.workspaces.id, workspaceId));
  const [settings] = await tx.select().from(s.workspaceSettings).where(eq(s.workspaceSettings.workspaceId, workspaceId));
  const [policy] = await tx.select().from(s.securityPolicies).where(eq(s.securityPolicies.workspaceId, workspaceId));
  const members = await tx
    .select({ userId: s.users.id, email: s.users.email, displayName: s.users.displayName, role: s.workspaceMembers.role, status: s.workspaceMembers.status, jobTitle: s.workspaceMembers.jobTitle, department: s.workspaceMembers.department, capacityHoursWeek: s.workspaceMembers.capacityHoursWeek, joinedAt: s.workspaceMembers.joinedAt })
    .from(s.workspaceMembers)
    .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
    .orderBy(asc(s.users.displayName));
  const teams = await tx.select().from(s.teams);
  const teamMembers = await tx.select({ teamId: s.teamMembers.teamId, userId: s.teamMembers.userId }).from(s.teamMembers);
  const templates = await tx.select().from(s.projectTemplates);
  const calendars = await tx.select().from(s.holidayCalendars).where(eq(s.holidayCalendars.workspaceId, workspaceId));
  const holidays = calendars.length ? await tx.select().from(s.holidays).where(inArray(s.holidays.calendarId, calendars.map((c) => c.id))) : [];
  out['workspace.json'] = json({
    exportedAt: new Date().toISOString(),
    workspace: { id: ws.id, slug: ws.slug, name: ws.name, dataRegion: ws.dataRegion, status: ws.status, createdAt: ws.createdAt },
    settings,
    securityPolicy: policy ? { ...policy, workspaceId: undefined } : null,
    members,
    teams: teams.map((t) => ({ ...t, memberIds: teamMembers.filter((m) => m.teamId === t.id).map((m) => m.userId) })),
    holidayCalendars: calendars.map((c) => ({ ...c, holidays: holidays.filter((h) => h.calendarId === c.id).map((h) => ({ date: h.date, name: h.name, kind: h.kind })) })),
    projectTemplates: templates,
  });
  out['members.csv'] = csv([['อีเมล', 'ชื่อ', 'บทบาท', 'สถานะ', 'ตำแหน่ง', 'แผนก'], ...members.map((m) => [m.email, m.displayName, m.role, m.status, m.jobTitle, m.department])]);

  const people = new Map(members.map((m) => [m.userId, m.displayName]));
  const projects = await tx.select().from(s.projects).orderBy(asc(s.projects.key));
  let total = 0;
  const filesManifest: Record<string, unknown>[] = [];

  for (const p of projects) {
    const dir = `projects/${safe(p.key)}`;
    const [modules, phases, sprints, milestones, labels, pMembers, statuses, baselines, planChanges] = await Promise.all([
      tx.select().from(s.modules).where(eq(s.modules.projectId, p.id)),
      tx.select().from(s.phases).where(eq(s.phases.projectId, p.id)),
      tx.select().from(s.sprints).where(eq(s.sprints.projectId, p.id)),
      tx.select().from(s.milestones).where(eq(s.milestones.projectId, p.id)),
      tx.select().from(s.labels).where(eq(s.labels.projectId, p.id)),
      tx.select().from(s.projectMembers).where(eq(s.projectMembers.projectId, p.id)),
      tx.select().from(s.workflowStatuses).where(eq(s.workflowStatuses.projectId, p.id)),
      tx.select().from(s.planBaselines).where(eq(s.planBaselines.projectId, p.id)),
      tx.select().from(s.planChanges).where(eq(s.planChanges.projectId, p.id)),
    ]);
    out[`${dir}/project.json`] = json({ project: p, modules, phases, sprints, milestones, labels, members: pMembers, workflowStatuses: statuses, baselines, planChanges });

    const issues = await tx.select().from(s.issues).where(eq(s.issues.projectId, p.id)).orderBy(asc(s.issues.number));
    const ids = issues.map((i) => i.id);
    const statusName = new Map(statuses.map((x) => [x.id, x.name]));
    const moduleName = new Map(modules.map((m) => [m.id, m.name]));
    const [assignees, issueLabels, comments, activities, deps] = ids.length
      ? await Promise.all([
          tx.select().from(s.issueAssignees).where(inArray(s.issueAssignees.issueId, ids)),
          tx.select().from(s.issueLabels).where(inArray(s.issueLabels.issueId, ids)),
          tx.select().from(s.comments).where(inArray(s.comments.issueId, ids)),
          tx.select().from(s.activities).where(eq(s.activities.projectId, p.id)),
          tx.select().from(s.issueDependencies).where(inArray(s.issueDependencies.predecessorId, ids)),
        ])
      : [[], [], [], [], []];
    const labelName = new Map(labels.map((l) => [l.id, l.name]));
    const key = (n: number) => `${p.key}-${n}`;
    const by = <T extends { issueId: string }>(rows: T[]) => {
      const m = new Map<string, T[]>();
      for (const r of rows) m.set(r.issueId, [...(m.get(r.issueId) ?? []), r]);
      return m;
    };
    const [asgBy, lblBy, cmtBy, actBy] = [by(assignees), by(issueLabels), by(comments), by(activities.filter((a): a is typeof a & { issueId: string } => !!a.issueId))];
    out[`${dir}/issues.json`] = json(
      issues.map((i) => ({
        ...i,
        key: key(i.number),
        status: statusName.get(i.statusId) ?? null,
        assigneeIds: (asgBy.get(i.id) ?? []).map((a) => a.userId),
        labels: (lblBy.get(i.id) ?? []).map((l) => labelName.get(l.labelId)).filter(Boolean),
        comments: (cmtBy.get(i.id) ?? []).map((c) => ({ id: c.id, authorId: c.authorId, body: c.body, createdAt: c.createdAt, editedAt: c.editedAt, deletedAt: c.deletedAt })),
        activities: (actBy.get(i.id) ?? []).map((a) => ({ verb: a.verb, field: a.field, oldValue: a.oldValue, newValue: a.newValue, actorId: a.actorId, actorKind: a.actorKind, at: a.createdAt })),
      })),
    );
    out[`${dir}/dependencies.json`] = json(deps);
    out[`${dir}/issues.csv`] = csv([
      ['Key', 'ชื่องาน', 'Module', 'Status', 'Priority', 'ผู้รับผิดชอบ', 'Man-Day', 'Plan Start', 'Plan End', 'Actual Start', 'Actual End', 'ลบเมื่อ'],
      ...issues.map((i) => [key(i.number), i.title, moduleName.get(i.moduleId ?? '') ?? '', statusName.get(i.statusId) ?? '', i.priority, (asgBy.get(i.id) ?? []).map((a) => people.get(a.userId) ?? a.userId).join('; '), i.estimateMd, i.planStart, i.planEnd, i.actualStart, i.actualEnd, i.deletedAt?.toISOString()]),
    ]);

    // ไฟล์แนบของโปรเจกต์ (เวอร์ชันล่าสุด)
    const files = await tx.select().from(s.files).where(eq(s.files.projectId, p.id));
    const versions = files.length ? await tx.select().from(s.fileVersions).where(inArray(s.fileVersions.fileId, files.map((f) => f.id))) : [];
    for (const f of files) {
      const v = versions.find((x) => x.id === f.currentVersionId);
      const item: Record<string, unknown> = { project: p.key, fileId: f.id, name: f.name, kind: f.kind, mime: f.mime, linkUrl: f.linkUrl, sizeBytes: v?.sizeBytes ?? null, deletedAt: f.deletedAt, included: false };
      if (v && f.kind === 'upload' && !f.deletedAt && v.sizeBytes <= MAX_FILE && total + v.sizeBytes <= MAX_TOTAL) {
        try {
          out[`${dir}/files/${f.id.slice(0, 8)}-${safe(f.name)}`] = new Uint8Array(await readFile(storage.path(v.storageKey)));
          total += v.sizeBytes;
          item.included = true;
          item.path = `${dir}/files/${f.id.slice(0, 8)}-${safe(f.name)}`;
        } catch {
          item.note = 'อ่านไฟล์จากที่เก็บไม่ได้';
        }
      } else if (v && v.sizeBytes > MAX_FILE) item.note = 'ไฟล์ใหญ่เกินกว่าจะใส่ใน zip · ดาวน์โหลดจากหน้าไฟล์';
      filesManifest.push(item);
    }
  }
  out['files-manifest.json'] = json(filesManifest);
  out['README.txt'] = strToU8(`Export ของ Workspace ${ws.name} (${ws.slug})\nสร้างเมื่อ ${new Date().toISOString()}\n\n- workspace.json  ตั้งค่า สมาชิก ทีม ปฏิทิน Template\n- projects/<KEY>/project.json  โครงสร้างโปรเจกต์ Sprint Baseline\n- projects/<KEY>/issues.json|csv  งาน พร้อมคอมเมนต์และประวัติ\n- files-manifest.json  รายการไฟล์ (ไฟล์ที่ใส่ใน zip อยู่ใต้ projects/<KEY>/files)\n`);
  return { zip: Buffer.from(zipSync(out, { level: 6 })), projects: projects.length, files: filesManifest.length };
}

/** ข้อมูลส่วนบุคคลของคนหนึ่งใน Workspace นี้ (คำขอสำเนาข้อมูล PDPA) */
export async function buildSubjectBundle(tx: Tx, workspaceId: string, userId: string) {
  const [user] = await tx.select({ id: s.users.id, email: s.users.email, displayName: s.users.displayName, firstName: s.users.firstName, lastName: s.users.lastName, phone: s.users.phone, about: s.users.about, createdAt: s.users.createdAt }).from(s.users).where(eq(s.users.id, userId));
  const [member] = await tx.select().from(s.workspaceMembers).where(eq(s.workspaceMembers.userId, userId));
  const cols = { issueId: s.issues.id, number: s.issues.number, projectId: s.issues.projectId, title: s.issues.title };
  const reported = await tx.select(cols).from(s.issues).where(eq(s.issues.reporterId, userId));
  const assigned = await tx.select(cols).from(s.issueAssignees).innerJoin(s.issues, eq(s.issues.id, s.issueAssignees.issueId)).where(eq(s.issueAssignees.userId, userId));
  const comments = await tx.select({ id: s.comments.id, issueId: s.comments.issueId, body: s.comments.body, createdAt: s.comments.createdAt }).from(s.comments).where(eq(s.comments.authorId, userId));
  const notifications = await tx.select({ eventType: s.notifications.eventType, payload: s.notifications.payload, createdAt: s.notifications.createdAt }).from(s.notifications).where(eq(s.notifications.recipientId, userId));
  const projectMemberships = await tx.select({ projectId: s.projectMembers.projectId, role: s.projectMembers.role }).from(s.projectMembers).where(eq(s.projectMembers.userId, userId));
  return { exportedAt: new Date().toISOString(), workspaceId, user, membership: member ?? null, projectMemberships, issuesReported: reported, issuesAssigned: assigned, comments, notifications };
}
