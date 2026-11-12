// O31 · กู้คืนข้อมูลลูกค้า (บอร์ด 21 · Z6–Z9) · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mailer } from '../src/mail.js';
import { customer, reauth, staff, startOps, type Customer, type Staff, type TestOps } from './helpers.js';

const DAY = 86_400_000;
let t: TestOps;
let mail: Mailer;
let owner: Staff, support: Staff, finance: Staff, engineer: Staff, auditor: Staff;
let a: Customer, b: Customer;
let adminId: string, memberId: string;
let project: string, otherProject: string;
let ticket: string, memberTicket: string, otherTicket: string;
let typeId: string, statusId: string;
let n = 0;

const q = (sql: string, params: unknown[] = []) => t.owner.query(sql, params);
async function user(email: string, name: string) {
  return (await q(`INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id`, [email, name])).rows[0].id as string;
}
async function mkProject(ws: string, key: string, name: string, ownerId: string) {
  const p = (await q(`INSERT INTO projects (workspace_id, key, name, start_date, golive_date, owner_user_id) VALUES ($1,$2,$3,'2026-11-05','2027-04-21',$4) RETURNING id`, [ws, key, name, ownerId])).rows[0].id as string;
  const wf = (await q(`INSERT INTO workflows (workspace_id, project_id, name) VALUES ($1,$2,'มาตรฐาน') RETURNING id`, [ws, p])).rows[0].id;
  statusId = (await q(`INSERT INTO workflow_statuses (workspace_id, project_id, workflow_id, name, category) VALUES ($1,$2,$3,'To do','todo') RETURNING id`, [ws, p, wf])).rows[0].id;
  typeId = (await q(`INSERT INTO issue_types (workspace_id, project_id, workflow_id, name) VALUES ($1,$2,$3,'Task') RETURNING id`, [ws, p, wf])).rows[0].id;
  return p;
}
async function mkIssue(ws: string, projectId: string, parentId: string | null = null) {
  const types = (await q(`SELECT id FROM issue_types WHERE project_id = $1`, [projectId])).rows[0].id;
  const status = (await q(`SELECT id FROM workflow_statuses WHERE project_id = $1`, [projectId])).rows[0].id;
  return (await q(`INSERT INTO issues (workspace_id, project_id, number, issue_type_id, status_id, title, parent_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, number`, [ws, projectId, ++n, types, status, `งานลับของลูกค้า ${n}`, parentId])).rows[0] as { id: string; number: number };
}
/** ลบแบบเดียวกับ API ลูกค้า: deleted_at + activities.deleted (cascadeRootId) */
async function softDelete(ws: string, projectId: string, ids: string[], by: string, at: Date, root = ids[0]) {
  await q(`UPDATE issues SET deleted_at = $2, deleted_by = $3 WHERE id = ANY($1)`, [ids, at, by]);
  for (const id of ids) await q(`INSERT INTO activities (workspace_id, project_id, issue_id, actor_id, verb, field, new_value) VALUES ($1,$2,$3,$4,'deleted','deletedAt',$5)`, [ws, projectId, id, by, { deletedAt: at.toISOString(), cascadeRootId: root }]);
}
async function mkTicket(ws: string | null, requesterUserId: string | null, email: string, subject: string) {
  return (await q(`INSERT INTO support_tickets (workspace_id, requester_user_id, requester_email, subject) VALUES ($1,$2,$3,$4) RETURNING id`, [ws, requesterUserId, email, subject])).rows[0].id as string;
}
const customerAudit = async (ws: string, action: string) => (await q(`SELECT actor_kind, summary FROM audit_logs WHERE workspace_id = $1 AND action = $2 ORDER BY created_at`, [ws, action])).rows;

beforeAll(async () => {
  t = await startOps();
  mail = t.app.get(Mailer);
  owner = await staff(t, 'owner@friday.example.com', 'Olive Owner', ['owner', 'support']);
  support = await staff(t, 'support@friday.example.com', 'Sam Support', 'support');
  finance = await staff(t, 'finance@friday.example.com', 'Fin Finance', 'finance');
  engineer = await staff(t, 'eng@friday.example.com', 'Eve Engineer', ['engineer']);
  auditor = await staff(t, 'audit@friday.example.com', 'Ari Auditor', ['auditor']);
  a = await customer(t, 'orbit-demo', { plan: 'team_l', status: 'active', admins: ['ops@orbit-demo.example.com'] });
  b = await customer(t, 'other-demo');
  adminId = (await q(`SELECT id FROM users WHERE email = 'ops@orbit-demo.example.com'`)).rows[0].id;
  memberId = await user('dev@orbit-demo.example.com', 'สมชาย');
  await q(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'member')`, [a.id, memberId]);
  project = await mkProject(a.id, 'DP', 'Payment Gateway v2', a.owner);
  otherProject = await mkProject(b.id, 'DP', 'ของลูกค้าอื่น', b.owner);
  ticket = await mkTicket(a.id, adminId, 'ops@orbit-demo.example.com', 'ลบงานผิดทั้ง Sprint');
  memberTicket = await mkTicket(a.id, null, 'dev@orbit-demo.example.com', 'ขอกู้งาน');
  otherTicket = await mkTicket(b.id, b.owner, 'owner@other-demo.example.com', 'เรื่องอื่น');
});
afterAll(() => t.close());

describe('สิทธิ์', () => {
  it('Support / Owner / วิศวกร / ผู้ตรวจอ่านได้ · การเงินไม่ได้ · กู้คืนเฉพาะ Support / Owner', async () => {
    for (const st of [owner, support, engineer, auditor]) expect((await st.agent.get('/ops/restore/summary')).status).toBe(200);
    expect((await finance.agent.get('/ops/restore/summary')).status).toBe(403);
    expect((await finance.agent.get(`/ops/restore/trash?workspaceId=${a.id}&ticketId=${ticket}`)).status).toBe(403);
    const body = { workspaceId: a.id, ticketId: ticket, type: 'issue', ids: [project], reason: 'ทดสอบสิทธิ์' };
    for (const st of [engineer, auditor, finance]) expect((await st.agent.post('/ops/restore').send(body)).status).toBe(403);
  });
});

describe('ค้นข้อมูลที่ลบ · กู้คืนให้ลูกค้า (Z6)', () => {
  let parent: { id: string; number: number }, subs: { id: string }[], batch: { id: string; number: number }[], single: { id: string; number: number };

  it('ต้องเลือก Ticket ของ Workspace นั้น · สรุปรายการโดยไม่แสดงชื่องาน · จัดชุดที่ลบใน 2 นาที', async () => {
    parent = await mkIssue(a.id, project);
    subs = [await mkIssue(a.id, project, parent.id), await mkIssue(a.id, project, parent.id)];
    batch = [parent, await mkIssue(a.id, project), await mkIssue(a.id, project)];
    single = await mkIssue(a.id, project);
    const at = new Date(Date.now() - 2 * DAY);
    await softDelete(a.id, project, [parent.id, ...subs.map((x) => x.id)], adminId, at, parent.id);
    await softDelete(a.id, project, [batch[1]!.id], adminId, new Date(at.getTime() + 30_000));
    await softDelete(a.id, project, [batch[2]!.id], adminId, new Date(at.getTime() + 60_000));
    await softDelete(a.id, project, [single.id], a.owner, new Date(Date.now() - 20 * DAY));
    // ไฟล์ 2 ไฟล์ที่ลบพร้อมกัน · ลูกค้าอื่นมีงานในถังขยะด้วย (ต้องไม่ปน)
    for (const name of ['สเปกลับ.pdf', 'ภาพลับ.png']) {
      const f = (await q(`INSERT INTO files (workspace_id, project_id, name, uploaded_by, deleted_at, deleted_by) VALUES ($1,$2,$3,$4, now() - interval '3 days', $5) RETURNING id`, [a.id, project, name, a.owner, memberId])).rows[0].id;
      await q(`INSERT INTO file_versions (workspace_id, file_id, version_no, storage_key, size_bytes, uploaded_by) VALUES ($1,$2,1,$3,1048576,$4)`, [a.id, f, `k/${f}`, a.owner]);
    }
    const foreign = await mkIssue(b.id, otherProject);
    await softDelete(b.id, otherProject, [foreign.id], b.owner, new Date());

    expect((await support.agent.get(`/ops/restore/trash?workspaceId=${a.id}`)).status).toBe(400);
    expect((await support.agent.get(`/ops/restore/trash?workspaceId=${a.id}&ticketId=${otherTicket}`)).body.error.code).toBe('ticket_workspace_mismatch');
    const r = await support.agent.get(`/ops/restore/trash?workspaceId=${a.id}&ticketId=${ticket}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.ticket).toMatchObject({ requesterEmail: 'ops@orbit-demo.example.com', requesterRole: 'admin', eligible: true });
    expect(r.body.counts).toEqual({ all: 3, project: 0, issue: 2, file: 1 });
    const issueRows = r.body.items.filter((i: { type: string }) => i.type === 'issue');
    const grouped = issueRows.find((i: { count: number }) => i.count === 3);
    expect(grouped).toMatchObject({ project: { key: 'DP', name: 'Payment Gateway v2' }, subtasks: 2, deletedBy: { name: 'ops', role: 'admin' } });
    expect(grouped.keys).toEqual(batch.map((x) => `DP-${x.number}`));
    expect(grouped.ids.sort()).toEqual(batch.map((x) => x.id).sort());
    expect(r.body.items.find((i: { type: string }) => i.type === 'file')).toMatchObject({ count: 2, sizeBytes: 2 * 1048576, deletedBy: { name: 'สมชาย', role: 'member' } });
    // ไม่มีชื่องาน / ชื่อไฟล์ในคำตอบ
    expect(JSON.stringify(r.body)).not.toContain('งานลับ');
    expect(JSON.stringify(r.body)).not.toContain('ลับ.pdf');
    const tickets = (await engineer.agent.get(`/ops/restore/tickets?workspaceId=${a.id}`)).body;
    expect(tickets.items.map((x: { subject: string; eligible: boolean }) => [x.subject, x.eligible]).sort()).toEqual([['ขอกู้งาน', false], ['ลบงานผิดทั้ง Sprint', true]]);
    const member = await support.agent.get(`/ops/restore/trash?workspaceId=${a.id}&ticketId=${memberTicket}`);
    expect(member.body.ticket).toMatchObject({ requesterRole: 'member', eligible: false });
  });

  it('Ticket จากสมาชิกธรรมดากู้ไม่ได้ · กู้ชุดพร้อม Sub-task · Audit ทั้งลูกค้า (ทีม Friday) และทีม · อีเมล Owner / Admin · ตอบ Ticket', async () => {
    const body = { workspaceId: a.id, type: 'issue', ids: batch.map((x) => x.id), reason: 'ลูกค้าแจ้งว่าลบทั้ง Sprint ผิด' };
    const denied = await support.agent.post('/ops/restore').send({ ...body, ticketId: memberTicket });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('requester_not_admin');
    const before = mail.sent.length;
    const r = await support.agent.post('/ops/restore').send({ ...body, ticketId: ticket });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ type: 'issue', restored: 3, notified: 2, replied: true });
    const rows = (await q(`SELECT id, deleted_at, deleted_by FROM issues WHERE id = ANY($1)`, [[...batch.map((x) => x.id), ...subs.map((x) => x.id)]])).rows;
    expect(rows.every((x) => x.deleted_at === null && x.deleted_by === null)).toBe(true);
    expect((await q(`SELECT actor_kind FROM activities WHERE issue_id = $1 AND verb = 'restored'`, [parent.id])).rows).toEqual([{ actor_kind: 'friday_staff' }]);
    const [log] = await customerAudit(a.id, 'restore.issue');
    expect(log.actor_kind).toBe('friday_staff');
    expect(log.summary).toContain('Ticket #');
    expect((await q(`SELECT roles FROM staff_audit_logs WHERE action = 'restore.issue'`)).rows[0].roles).toEqual(['support']);
    const sent = mail.sent.slice(before).map((m) => m.to).sort();
    expect(sent).toEqual(['ops@orbit-demo.example.com', 'ops@orbit-demo.example.com', 'owner@orbit-demo.example.com'].sort());
    const reply = (await q(`SELECT body, author_kind FROM support_ticket_messages WHERE ticket_id = $1`, [ticket])).rows;
    expect(reply).toEqual([expect.objectContaining({ author_kind: 'staff' })]);
    expect(reply[0].body).toContain(`DP-${parent.number} (+ Sub-task 2)`);
    expect((await support.agent.post('/ops/restore').send({ ...body, ticketId: ticket })).body.error.code).toBe('not_deleted');
    expect((await support.agent.get('/ops/restore/summary')).body.restored30d).toMatchObject({ total: 1, issue: 1 });
  });

  it('กู้ไฟล์ (ไม่แจ้งอีเมลเมื่อปิดตัวเลือก) · งานของ Workspace อื่น 404', async () => {
    const files = (await q(`SELECT id FROM files WHERE workspace_id = $1 AND deleted_at IS NOT NULL`, [a.id])).rows.map((r) => r.id);
    const before = mail.sent.length;
    const r = await support.agent.post('/ops/restore').send({ workspaceId: a.id, ticketId: ticket, type: 'file', ids: files, reason: 'ลบไฟล์ผิดโฟลเดอร์', notify: false, replyTicket: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ restored: 2, notified: 0, replied: false });
    expect(mail.sent.length).toBe(before);
    const foreign = (await q(`SELECT id FROM issues WHERE workspace_id = $1`, [b.id])).rows[0].id;
    expect((await support.agent.post('/ops/restore').send({ workspaceId: a.id, ticketId: ticket, type: 'issue', ids: [foreign], reason: 'ข้าม Workspace' })).status).toBe(404);
  });

  it('โปรเจกต์: Key ซ้ำกับโปรเจกต์ปัจจุบันต้องเลือก Key ใหม่ · เก็บ Key เดิมเป็น alias', async () => {
    const mkt = await mkProject(a.id, 'MKT', 'Marketing Site 2026', a.owner);
    await q(`UPDATE projects SET deleted_at = now() - interval '10 days', deleted_by = $2 WHERE id = $1`, [mkt, a.owner]);
    await mkProject(a.id, 'MKT', 'Marketing 2027', a.owner);
    const list = (await support.agent.get(`/ops/restore/trash?workspaceId=${a.id}&ticketId=${ticket}`)).body;
    expect(list.items.find((i: { type: string }) => i.type === 'project')).toMatchObject({ project: { key: 'MKT', name: 'Marketing Site 2026' }, keyTaken: true, deletedBy: { role: 'owner' } });
    const body = { workspaceId: a.id, ticketId: ticket, type: 'project', ids: [mkt], reason: 'Owner ขอโปรเจกต์คืน', replyTicket: false };
    const taken = await support.agent.post('/ops/restore').send(body);
    expect(taken.status).toBe(409);
    expect(taken.body.error).toMatchObject({ code: 'project_key_taken', details: { key: 'MKT', suggestedKey: 'MKT2' } });
    const r = await support.agent.post('/ops/restore').send({ ...body, newKey: 'mks' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.items).toEqual(['MKT → MKS · Marketing Site 2026']);
    expect((await q(`SELECT key, deleted_at FROM projects WHERE id = $1`, [mkt])).rows[0]).toEqual({ key: 'MKS', deleted_at: null });
    expect((await q(`SELECT project_id FROM project_key_aliases WHERE old_key = 'MKT'`)).rows).toEqual([{ project_id: mkt }]);
  });

  it('Z9: ค้นด้วยเลขงาน · ยังอยู่ / ในถังขยะ / ลบถาวรแล้ว (จาก Audit log)', async () => {
    const lookup = (s: string) => support.agent.get(`/ops/restore/lookup?workspaceId=${a.id}&q=${encodeURIComponent(s)}`);
    expect((await lookup(`DP-${parent.number}`)).body).toMatchObject({ status: 'live', kind: 'issue' });
    expect((await lookup(`dp-${single.number}`)).body).toMatchObject({ status: 'in_trash' });
    await q(`INSERT INTO audit_logs (workspace_id, actor_id, actor_kind, category, action, summary, created_at) VALUES ($1,$2,'user','data','issue.deleted','ลบ DP-12 พร้อม Sub-task 0 งาน', now() - interval '40 days')`, [a.id, a.owner]);
    await q(`INSERT INTO audit_logs (workspace_id, actor_kind, category, action, summary, created_at) VALUES ($1,'system','data','trash.purged','ลบถาวรอัตโนมัติ (พ้นถังขยะ 30 วัน): งาน 1 · โปรเจกต์ 0 · ไฟล์ 0', now() - interval '10 days')`, [a.id]);
    const gone = (await lookup('DP-12')).body;
    expect(gone).toMatchObject({ status: 'purged', kind: 'issue', trashDays: 30, backupDays: 35 });
    expect(gone.purgedAt).toBeTruthy();
    expect((await lookup('DP-999')).body.status).toBe('not_found');
  });
});

describe('Workspace ที่รอลบถาวร (Z7 · Z8)', () => {
  let ws: Customer;
  let wsTicket: string;

  beforeAll(async () => {
    ws = await customer(t, 'technova-demo', { plan: 'team_s', status: 'canceled' });
    await q(`UPDATE workspaces SET deleted_at = now() - interval '25 days', deleted_by = $2, status = 'pending_delete' WHERE id = $1`, [ws.id, ws.owner]);
    wsTicket = await mkTicket(ws.id, ws.owner, 'owner@technova-demo.example.com', 'ขอกู้คืน');
  });

  it('แสดงวันลบถาวร ยืดไปแล้วกี่วัน และ Ticket ของลูกค้า', async () => {
    const r = await engineer.agent.get('/ops/restore/workspaces');
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([expect.objectContaining({ id: ws.id, name: 'Co technova-demo', plan: 'team_s', planStatus: 'canceled', daysLeft: 5, extendedDays: 0, extendLeft: 30, deletedBy: { name: 'owner', role: 'owner' }, tickets: [expect.objectContaining({ subject: 'ขอกู้คืน' })] })]);
    expect((await support.agent.get('/ops/restore/summary')).body).toMatchObject({ pendingWorkspaces: 1, pendingSoon: 1 });
  });

  it('ยืดเวลารวม ≤ 30 วันทำเองได้ + อีเมล Owner · เกินต้องขออนุมัติ (202) แล้ว Owner อนุมัติ', async () => {
    const url = `/ops/restore/workspaces/${ws.id}/extend`;
    expect((await engineer.agent.post(url).send({ days: 7, ticketId: wsTicket, reason: 'Owner ขอเวลา' })).status).toBe(403);
    const before = mail.sent.length;
    const r = await support.agent.post(url).send({ days: 14, ticketId: wsTicket, reason: 'Owner ขอเวลาส่งออกข้อมูล' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ extendedDays: 14, notified: 1 });
    expect(mail.sent.slice(before)[0]).toMatchObject({ to: 'owner@technova-demo.example.com' });
    expect((await customerAudit(ws.id, 'restore.extended'))[0].actor_kind).toBe('friday_staff');

    const over = await support.agent.post(url).send({ days: 30, ticketId: wsTicket, reason: 'Owner ขอเวลาเพิ่มอีก' });
    expect(over.status).toBe(202);
    expect(over.body.pendingApproval).toMatchObject({ kind: 'restore.extend_purge', status: 'pending' });
    expect((await support.agent.get('/ops/restore/workspaces')).body.items[0]).toMatchObject({ extendedDays: 14, pendingApprovals: [{ kind: 'restore.extend_purge' }] });
    await reauth(owner);
    const ok = await owner.agent.post(`/ops/approvals/${over.body.pendingApproval.id}/approve`).send({ note: 'ลูกค้ารายใหญ่' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await support.agent.get('/ops/restore/workspaces')).body.items[0].extendedDays).toBe(44);
  });

  it('กู้ Workspace แทนลูกค้า: ต้องแตะ key · อนุมัติทุกครั้ง · ห้ามขอซ้ำ · อนุมัติแล้วกู้คืนและแจ้ง Owner', async () => {
    const url = `/ops/restore/workspaces/${ws.id}/restore`;
    const body = { ticketId: wsTicket, reason: 'Owner ยืนยันว่าลบผิดและต้องการใช้ต่อ' };
    expect((await support.agent.post(url).send(body)).body.error.code).toBe('reauth_required');
    await reauth(support);
    const r = await support.agent.post(url).send(body);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.pendingApproval).toMatchObject({ kind: 'restore.workspace', status: 'pending' });
    expect((await support.agent.post(url).send(body)).body.error.code).toBe('restore_pending');
    expect((await q(`SELECT deleted_at FROM workspaces WHERE id = $1`, [ws.id])).rows[0].deleted_at).not.toBeNull();

    const ok = await owner.agent.post(`/ops/approvals/${r.body.pendingApproval.id}/approve`).send({});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await q(`SELECT deleted_at, deleted_by, purge_after, status FROM workspaces WHERE id = $1`, [ws.id])).rows[0]).toEqual({ deleted_at: null, deleted_by: null, purge_after: null, status: 'active' });
    expect((await customerAudit(ws.id, 'restore.workspace'))[0].actor_kind).toBe('friday_staff');
    expect((await q(`SELECT approved_by FROM staff_audit_logs WHERE action = 'restore.workspace'`)).rows[0].approved_by).toBe(owner.id);
    expect((await support.agent.post(`/ops/restore/workspaces/${ws.id}/extend`).send({ days: 7, ticketId: wsTicket, reason: 'หลังกู้แล้ว' })).body.error.code).toBe('workspace_not_deleted');
    expect((await support.agent.get('/ops/restore/history')).body.items.map((i: { action: string }) => i.action)).toEqual(expect.arrayContaining(['restore.workspace', 'restore.extended', 'restore.issue']));
  });

  it('Workspace ที่ลบอยู่กู้งานในนั้นไม่ได้ (ใช้กู้ Workspace แทน) · เกินกำหนดแล้วยืดไม่ได้', async () => {
    const gone = await customer(t, 'expired-demo');
    await q(`UPDATE workspaces SET deleted_at = now() - interval '40 days', purge_after = now() - interval '1 hour' WHERE id = $1`, [gone.id]);
    const tk = await mkTicket(gone.id, gone.owner, 'owner@expired-demo.example.com', 'ช้าไป');
    expect((await support.agent.post(`/ops/restore/workspaces/${gone.id}/extend`).send({ days: 7, ticketId: tk, reason: 'ขอเวลาเพิ่ม' })).status).toBe(410);
    const r = await support.agent.post('/ops/restore').send({ workspaceId: gone.id, ticketId: tk, type: 'issue', ids: [gone.id], reason: 'ทดสอบ' });
    expect(r.body.error.code).toBe('workspace_deleted');
  });
});
