// O05 · คำขอ PDPA เหตุละเมิดข้อมูล และเอกสารกฎหมาย · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mailer } from '../src/mail.js';
import { customer, type Customer, reauth, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let mail: Mailer;
let owner: Staff;
let support: Staff;
let engineer: Staff;
let auditor: Staff;
let finance: Staff;
let a: Customer;
const DAY = 86_400_000;
const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

const member = async (c: Customer, email: string, role = 'member') => {
  const u = (await t.owner.query(`INSERT INTO users (email, display_name, phone) VALUES ($1, $2, '0800000000') RETURNING id`, [email, email.split('@')[0]])).rows[0].id as string;
  await t.owner.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)`, [c.id, u, role]);
  return u;
};

beforeAll(async () => {
  t = await startOps();
  mail = t.app.get(Mailer);
  owner = await staff(t, 'owner@friday.example.com', 'Olive Owner', 'admin');
  support = await staff(t, 'support@friday.example.com', 'Sam Support', 'support');
  engineer = await staff(t, 'eng@friday.example.com', 'Eve Engineer', ['engineer']);
  auditor = await staff(t, 'audit@office.example.com', 'Aud Office', ['auditor']);
  finance = await staff(t, 'finance@friday.example.com', 'Fin Finance', 'finance');
  a = await customer(t, 'pdpa-demo', { plan: 'team_m', status: 'active' });
});
afterAll(() => t.close());

describe('คำขอ PDPA', () => {
  let exportReq = '';

  it('บันทึกคำขอ (A3): นับ 30 วันจากวันที่ได้รับ · แจ้งรับเรื่อง · ซ้ำไม่ได้ · ไม่มีบัญชี = ส่งต่อ Owner', async () => {
    await member(a, 'somchai@pdpa-demo.example.com');
    const before = mail.sent.length;
    const r = await support.agent.post('/ops/privacy/requests').send({ requestType: 'export', requesterEmail: 'Somchai@pdpa-demo.example.com', receivedAt: addDays(today(), -2), details: 'ขอสำเนาข้อมูลทั้งหมด' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    exportReq = r.body.request.id;
    expect(r.body.request).toMatchObject({ requestType: 'export', requesterEmail: 'somchai@pdpa-demo.example.com', step: 1, status: 'open', identity: 'unverified', dueDate: addDays(today(), 28), daysLeft: 28, typeLabel: 'ขอสำเนาข้อมูล' });
    expect(r.body).toMatchObject({ acknowledged: true, forwardToOwner: false });
    expect(mail.sent.slice(before)[0].to).toBe('somchai@pdpa-demo.example.com');
    expect((await support.agent.post('/ops/privacy/requests').send({ requestType: 'export', requesterEmail: 'somchai@pdpa-demo.example.com' })).body.error.code).toBe('request_exists');
    const stranger = await support.agent.post('/ops/privacy/requests').send({ requestType: 'access', requesterEmail: 'end-customer@example.com', acknowledge: false });
    expect(stranger.body).toMatchObject({ forwardToOwner: true, acknowledged: false });
    expect((await support.agent.post('/ops/privacy/requests').send({ requestType: 'access', requesterEmail: 'nobody@example.com', identity: 'email_match' })).body.error.code).toBe('no_account');
    expect((await support.agent.post('/ops/privacy/requests').send({ requestType: 'export', requesterEmail: 'x@example.com', receivedAt: addDays(today(), 2) })).body.error.code).toBe('received_in_future');
    expect((await finance.agent.get('/ops/privacy/requests')).status).toBe(403);
    expect((await auditor.agent.get('/ops/privacy/requests')).body.items).toHaveLength(2);
  });

  it('ทำตามขั้น: ยืนยันตัวตนก่อน → ตรวจขอบเขต → ดำเนินการ → แจ้งผล (ปิด) · ประวัติทุกขั้น', async () => {
    expect((await support.agent.post(`/ops/privacy/requests/${exportReq}/advance`).send({ note: 'ข้ามขั้น' })).body.error.code).toBe('identity_unverified');
    expect((await support.agent.post(`/ops/privacy/requests/${exportReq}/verify`).send({ method: 'link_confirmed', note: 'ผู้ขอกดลิงก์ยืนยันแล้ว' })).body).toMatchObject({ step: 2, identity: 'link_confirmed' });
    expect((await support.agent.post(`/ops/privacy/requests/${exportReq}/advance`).send({ note: 'ขอบเขต 1 Workspace' })).body).toMatchObject({ step: 3, stepLabel: 'ตรวจขอบเขต' });
    expect((await support.agent.post(`/ops/privacy/requests/${exportReq}/advance`).send({ note: 'รวบรวมไฟล์ส่งออกแล้ว' })).body.step).toBe(4);
    const before = mail.sent.length;
    const done = await support.agent.post(`/ops/privacy/requests/${exportReq}/advance`).send({ note: 'ส่งไฟล์ให้ผู้ขอแล้ว', message: 'แนบลิงก์ดาวน์โหลดสำเนาข้อมูล (หมดอายุ 7 วัน)' });
    expect(done.body).toMatchObject({ status: 'completed', step: 5, sent: true });
    expect(mail.sent.slice(before)[0].text).toContain('ลิงก์ดาวน์โหลด');
    expect((await support.agent.post(`/ops/privacy/requests/${exportReq}/advance`).send({ note: 'อีกครั้ง' })).body.error.code).toBe('request_closed');
    const d = (await auditor.agent.get(`/ops/privacy/requests/${exportReq}`)).body;
    expect(d.history.map((h: { action: string }) => h.action)).toEqual(['privacy.request_created', 'privacy.identity_verified', 'privacy.request_advanced', 'privacy.request_advanced', 'privacy.request_completed']);
    expect(d.steps.every((x: { done: boolean }) => x.done)).toBe(true);
  });

  it('ปฏิเสธพร้อมเหตุผลตามกฎหมาย (A5) · ผู้ขอได้อีเมลพร้อมสิทธิ์ร้องเรียน สคส.', async () => {
    const r = (await support.agent.post('/ops/privacy/requests').send({ requestType: 'rectify', requesterEmail: 'somchai@pdpa-demo.example.com', acknowledge: false })).body.request;
    expect((await support.agent.post(`/ops/privacy/requests/${r.id}/reject`).send({ legalBasis: 'สั้น' })).status).toBe(400);
    const before = mail.sent.length;
    const x = await support.agent.post(`/ops/privacy/requests/${r.id}/reject`).send({ legalBasis: 'ต้องเก็บใบกำกับภาษีตามประมวลรัษฎากร 5 ปี', message: 'ข้อมูลในใบกำกับภาษีที่ออกแล้วแก้ไขไม่ได้' });
    expect(x.body).toMatchObject({ status: 'rejected', rejectionReason: 'ต้องเก็บใบกำกับภาษีตามประมวลรัษฎากร 5 ปี', sent: true });
    expect(mail.sent.slice(before)[0].text).toContain('สคส.');
  });
});

describe('ลบตามคำขอ (A6) · ต้องมีคนที่สองเสมอ', () => {
  let user = '';
  let req = '';

  beforeAll(async () => {
    user = await member(a, 'erase-me@pdpa-demo.example.com');
    await t.owner.query(`INSERT INTO user_sessions (user_id, token_hash) VALUES ($1, 'tok-erase-me')`, [user]);
    await t.owner.query(`INSERT INTO line_bindings (user_id, line_user_id) VALUES ($1, 'U-erase-me')`, [user]);
    req = (await support.agent.post('/ops/privacy/requests').send({ requestType: 'erase', requesterEmail: 'erase-me@pdpa-demo.example.com', identity: 'email_match', acknowledge: false })).body.request.id;
  });

  it('ต้องถึงขั้นตรวจขอบเขตก่อน · แตะ key ซ้ำ · พิมพ์ยืนยัน · แผนการลบบอกสิ่งที่เก็บต่อ', async () => {
    expect((await support.agent.post(`/ops/privacy/requests/${req}/erase`).send({ confirm: 'ลบข้อมูล', reason: 'ตามคำขอ' })).body.error.code).toBe('reauth_required');
    await reauth(support);
    expect((await support.agent.post(`/ops/privacy/requests/${req}/erase`).send({ confirm: 'ลบข้อมูล', reason: 'ตามคำขอทางอีเมล' })).body.error.code).toBe('not_ready');
    await support.agent.post(`/ops/privacy/requests/${req}/advance`).send({ note: 'ตรวจขอบเขตแล้ว 1 Workspace' });
    expect((await support.agent.post(`/ops/privacy/requests/${req}/advance`).send({ note: 'ลบเลย' })).body.error.code).toBe('use_erase');
    expect((await support.agent.post(`/ops/privacy/requests/${req}/erase`).send({ confirm: 'ลบ', reason: 'ตามคำขอทางอีเมล' })).status).toBe(400);
    const plan = (await support.agent.get(`/ops/privacy/requests/${req}`)).body;
    expect(plan.scope.memberships).toEqual([expect.objectContaining({ slug: 'pdpa-demo', role: 'member', soleOwner: false })]);
    expect(plan.erasePlan).toMatchObject({ backupDays: 35, blockers: [] });
  });

  it('ส่งขออนุมัติ (202) → Owner อนุมัติ → ถอนจาก Workspace และทำบัญชีให้ระบุตัวไม่ได้', async () => {
    const r = await support.agent.post(`/ops/privacy/requests/${req}/erase`).send({ confirm: 'ลบข้อมูล', reason: 'ตามคำขอทางอีเมล' });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.pendingApproval).toMatchObject({ kind: 'privacy.erase' });
    expect((await support.agent.post(`/ops/privacy/requests/${req}/erase`).send({ confirm: 'ลบข้อมูล', reason: 'กดซ้ำอีกครั้ง' })).body.error.code).toBe('erase_pending');
    await reauth(owner);
    const ok = await owner.agent.post(`/ops/approvals/${r.body.pendingApproval.id}/approve`).send({ note: 'ตรวจแล้ว' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.result).toEqual({ requestId: req, workspaces: 1, anonymized: true });
    const u = (await t.owner.query(`SELECT email, display_name, phone, disabled_at FROM users WHERE id = $1`, [user])).rows[0];
    expect(u).toMatchObject({ email: `erased-${user}@invalid.example`, display_name: 'ผู้ใช้ที่ถูกลบ', phone: null });
    expect(u.disabled_at).not.toBeNull();
    for (const table of ['user_sessions', 'line_bindings']) expect((await t.owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [user])).rows[0].n, table).toBe(0);
    expect((await t.owner.query(`SELECT status FROM workspace_members WHERE user_id = $1`, [user])).rows[0].status).toBe('deactivated');
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action = 'privacy.user_erased'`, [a.id])).rows[0].n).toBe(1);
    expect((await support.agent.get(`/ops/privacy/requests/${req}`)).body.request.step).toBe(4);
    expect((await support.agent.post(`/ops/privacy/requests/${req}/advance`).send({ note: 'แจ้งผู้ขอแล้ว' })).body.status).toBe('completed');
  });

  it('Owner ขอเองแล้วอนุมัติตัวเองไม่ได้ (ช่วงมี Owner คนเดียวต้องรอ) · Owner คนเดียวของ Workspace ลบไม่ได้', async () => {
    await member(a, 'second@pdpa-demo.example.com');
    const r = (await owner.agent.post('/ops/privacy/requests').send({ requestType: 'erase', requesterEmail: 'second@pdpa-demo.example.com', identity: 'email_match', acknowledge: false })).body.request;
    await owner.agent.post(`/ops/privacy/requests/${r.id}/advance`).send({ note: 'ตรวจขอบเขตแล้ว' });
    await reauth(owner);
    const e = await owner.agent.post(`/ops/privacy/requests/${r.id}/erase`).send({ confirm: 'ลบข้อมูล', reason: 'ตามคำขอ' });
    expect(e.status).toBe(202);
    expect((await owner.agent.post(`/ops/approvals/${e.body.pendingApproval.id}/approve`).send({})).body.error.code).toBe('self_approval_not_allowed');

    const sole = (await support.agent.post('/ops/privacy/requests').send({ requestType: 'erase', requesterEmail: 'owner@pdpa-demo.example.com', identity: 'email_match', acknowledge: false })).body.request;
    await support.agent.post(`/ops/privacy/requests/${sole.id}/advance`).send({ note: 'ตรวจขอบเขตแล้ว' });
    expect((await support.agent.post(`/ops/privacy/requests/${sole.id}/erase`).send({ confirm: 'ลบข้อมูล', reason: 'ตามคำขอ' })).body.error).toMatchObject({ code: 'sole_owner', details: { workspaces: ['pdpa-demo'] } });
  });
});

describe('เหตุละเมิดข้อมูล (A4) · 72 ชม.', () => {
  let id = '';

  it('แจ้งเหตุ: นับถอยหลัง 72 ชม. · บันทึกทุกขั้นแก้ไม่ได้ · การเงินแจ้งไม่ได้', async () => {
    const r = await engineer.agent.post('/ops/privacy/breaches').send({
      discoveredAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), description: 'ลิงก์ส่งออกข้อมูลของ pdpa-demo ถูกส่งผิดอีเมล', dataTypes: ['ชื่อ', 'อีเมล', 'ชื่องาน'], affectedCount: 23, workspaceIds: [a.id], risk: 'medium', containment: 'ปิดลิงก์ส่งออกแล้ว',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    id = r.body.id;
    expect(r.body).toMatchObject({ number: expect.any(Number), mustNotifyPdpc: true, overdue: false, ownerId: engineer.id });
    expect(r.body.hoursLeft).toBeGreaterThan(69);
    expect(r.body.hoursLeft).toBeLessThanOrEqual(70);
    expect((await finance.agent.post('/ops/privacy/breaches').send({ discoveredAt: new Date().toISOString(), description: 'x'.repeat(20), dataTypes: ['x'] })).status).toBe(403);
    const late = await engineer.agent.post('/ops/privacy/breaches').send({ discoveredAt: new Date(Date.now() - 80 * 3_600_000).toISOString(), description: 'พบล่าช้า ข้อมูลหลุดจากระบบสำรอง', dataTypes: ['อีเมล'], risk: 'high' });
    expect(late.body.overdue).toBe(true);
    expect((await engineer.agent.post('/ops/privacy/breaches').send({ discoveredAt: new Date(Date.now() + DAY).toISOString(), description: 'อนาคต อนาคต อนาคต', dataTypes: ['x'] })).body.error.code).toBe('discovered_in_future');
  });

  it('ประเมิน · ร่างหนังสือแจ้ง สคส. · แจ้ง สคส. (Owner) · แจ้ง Owner ลูกค้า · ปิด', async () => {
    expect((await owner.agent.post(`/ops/privacy/breaches/${id}/close`).send({ note: 'ปิด' })).body.error.code).toBe('pdpc_not_notified');
    const p = await engineer.agent.patch(`/ops/privacy/breaches/${id}`).send({ assessment: 'ผู้รับผิดไม่ได้เปิดลิงก์ ความเสี่ยงปานกลาง', note: 'ประเมินร่วมกับ DPO' });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const draft = (await engineer.agent.get(`/ops/privacy/breaches/${id}/pdpc-draft`)).body;
    expect(draft.text).toContain('ลิงก์ส่งออกข้อมูลของ pdpa-demo ถูกส่งผิดอีเมล');
    expect(draft.text).toContain('23 ราย');
    expect(draft.text).not.toContain('เกิน 72 ชั่วโมง');
    expect((await engineer.agent.post(`/ops/privacy/breaches/${id}/pdpc-notified`).send({ note: 'ส่งทางระบบ สคส.' })).status).toBe(403);
    expect((await owner.agent.post(`/ops/privacy/breaches/${id}/pdpc-notified`).send({ note: 'ส่งทางระบบ สคส.' })).body).toMatchObject({ late: false, hoursLeft: null });
    expect((await owner.agent.post(`/ops/privacy/breaches/${id}/pdpc-notified`).send({ note: 'ซ้ำ' })).body.error.code).toBe('already_notified');
    const before = mail.sent.length;
    const s = await owner.agent.post(`/ops/privacy/breaches/${id}/subjects-notified`).send({ note: 'ลิงก์ส่งออกถูกส่งผิดที่ เราปิดลิงก์แล้ว', notifyOwners: true });
    expect(s.body.sent).toBe(1);
    expect(mail.sent.slice(before)[0].to).toBe('owner@pdpa-demo.example.com');
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action = 'privacy.breach_notified'`, [a.id])).rows[0].n).toBe(1);
    expect((await owner.agent.post(`/ops/privacy/breaches/${id}/close`).send({ note: 'ดำเนินการครบ' })).body.closedAt).not.toBeNull();
    expect((await engineer.agent.patch(`/ops/privacy/breaches/${id}`).send({ note: 'หลังปิด' })).body.error.code).toBe('breach_closed');
    const log = (await auditor.agent.get(`/ops/privacy/breaches/${id}`)).body.log.map((l: { action: string }) => l.action);
    expect(log).toEqual(['privacy.breach_opened', 'privacy.breach_updated', 'privacy.breach_pdpc_notified', 'privacy.breach_subjects_notified', 'privacy.breach_closed']);
  });

  it('Workspace ที่รอลบแสดงในหน้า Privacy', async () => {
    const gone = await customer(t, 'pdpa-gone', { plan: 'team_s', status: 'canceled' });
    await t.owner.query(`UPDATE workspaces SET status = 'pending_delete' WHERE id = $1`, [gone.id]);
    expect((await support.agent.get('/ops/privacy/pending-deletes')).body.items.map((w: { slug: string }) => w.slug)).toEqual(['pdpa-gone']);
  });
});

describe('เอกสารกฎหมาย (A7)', () => {
  let v2 = '';
  const body = 'ข้อกำหนดการใช้งาน Friday Manage (ตัวอย่าง) '.repeat(5);

  it('สร้างเวอร์ชัน: Owner เท่านั้น แตะ key ซ้ำ · เปลี่ยนสาระสำคัญต้องแจ้งล่วงหน้า 30 วัน · เวอร์ชันต้องใหม่กว่า', async () => {
    const fresh = await staff(t, 'owner-legal@friday.example.com', 'Lee Legal', ['owner']);
    const v1 = { docType: 'terms', version: '1', summary: 'ฉบับแรกของข้อกำหนดการใช้งาน', body, effectiveAt: new Date().toISOString(), requiresAcceptance: false };
    expect((await fresh.agent.post('/ops/legal/documents').send(v1)).body.error.code).toBe('reauth_required');
    await reauth(fresh);
    const r1 = await fresh.agent.post('/ops/legal/documents').send(v1);
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r1.body.document).toMatchObject({ version: '1', requiresAcceptance: false, createdByStaff: fresh.id });
    const v2body = { ...v1, version: '2', summary: 'ขยายระยะขอคืนเงินเป็น 14 วัน', requiresAcceptance: true };
    expect((await fresh.agent.post('/ops/legal/documents').send({ ...v2body, effectiveAt: new Date(Date.now() + 10 * DAY).toISOString() })).body.error.code).toBe('notice_too_short');
    const r2 = await fresh.agent.post('/ops/legal/documents').send({ ...v2body, effectiveAt: new Date(Date.now() + 31 * DAY).toISOString() });
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    v2 = r2.body.document.id;
    expect((await fresh.agent.post('/ops/legal/documents').send({ ...v2body, version: '1.5', effectiveAt: new Date(Date.now() + 40 * DAY).toISOString() })).body.error.code).toBe('version_not_newer');
    expect((await support.agent.post('/ops/legal/documents').send(v2body)).status).toBe(403);
    expect((await auditor.agent.post('/ops/legal/documents').send(v2body)).status).toBe(403);
  });

  it('รายการเอกสาร: ฉบับที่ใช้ ฉบับตั้งเวลา · ยกเลิกได้เฉพาะฉบับที่ยังไม่มีผล', async () => {
    const r = await auditor.agent.get('/ops/legal/documents');
    expect(r.status).toBe(200);
    const terms = r.body.items.find((g: { docType: string; locale: string }) => g.docType === 'terms' && g.locale === 'th');
    expect(terms.current).toMatchObject({ version: '1', requiresAcceptance: false, pendingUsers: null });
    expect(terms.scheduled.map((d: { version: string }) => d.version)).toEqual(['2']);
    expect((await auditor.agent.get(`/ops/legal/documents/${v2}`)).body.previous.version).toBe('1');
    await reauth(owner);
    expect((await owner.agent.delete(`/ops/legal/documents/${terms.current.id}`)).body.error.code).toBe('already_effective');
    expect((await owner.agent.delete(`/ops/legal/documents/${v2}`)).body).toEqual({ id: v2, cancelled: true });
  });

  it('ประวัติการยอมรับ: ค้นด้วยอีเมล / Workspace · ส่งออก CSV', async () => {
    const doc = (await t.owner.query(`SELECT id FROM legal_documents WHERE doc_type = 'terms' AND version = '1'`)).rows[0].id;
    await t.owner.query(`INSERT INTO legal_acceptances (user_id, workspace_id, document_id, ip) VALUES ($1, $2, $3, '203.0.113.7')`, [a.owner, a.id, doc]);
    const r = await auditor.agent.get('/ops/legal/acceptances?q=pdpa-demo');
    expect(r.body.items).toEqual([expect.objectContaining({ email: 'owner@pdpa-demo.example.com', workspace: 'pdpa-demo', docType: 'terms', version: '1', ip: '203.0.113.7', channel: 'in_app' })]);
    const csv = await auditor.agent.get('/ops/legal/acceptances/export?docType=terms');
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    expect(csv.text).toContain('203.0.113.7');
    expect((await support.agent.get('/ops/legal/acceptances')).status).toBe(403);
  });
});
