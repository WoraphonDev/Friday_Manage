// O50 · ตรวจจับการใช้ผิด · ข้อมูลสมมติเท่านั้น (โดเมน .example / IP ช่วงเอกสาร 203.0.113.0/24)
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AbuseService } from '../src/abuse/abuse.service.js';
import { Mailer } from '../src/mail.js';
import { customer, type Customer, reauth, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let boss: Staff;
let eng: Staff;
let sam: Staff;
let spam: Customer;
let paid: Customer;
let svc: AbuseService;
const IP = '203.0.113.24';
const TEMP = 'tempmail.example';

/** คำเชิญ n รายการไปโดเมนภายนอกภายใน 1 ชม. ที่ผ่านมา · ข้อความมีลิงก์ */
async function invites(c: Customer, n: number) {
  for (let i = 0; i < n; i++) {
    await t.owner.query(
      `INSERT INTO invitations (workspace_id, email, token_hash, expires_at, invited_by, message, created_at) VALUES ($1, $2, $3, now() + interval '7 days', $4, $5, now() - interval '10 minutes')`,
      [c.id, `p${i}@target${i % 7}.example.org`, randomUUID(), c.owner, 'โปรโมชันพิเศษ https://deal.example.net/x และ http://promo.example.org'],
    );
  }
}

beforeAll(async () => {
  t = await startOps();
  svc = t.app.get(AbuseService);
  boss = await staff(t, 'boss@friday.example.com', 'บอส ตัวอย่าง', ['owner']);
  eng = await staff(t, 'eng@friday.example.com', 'วิศวกร เอ', ['engineer']);
  sam = await staff(t, 'sam@friday.example.com', 'Sam Support', 'support');
  // โดเมนชั่วคราวที่ทีมเพิ่มเองนับเป็นสัญญาณด้วย
  await t.owner.query(`INSERT INTO abuse_blocks (kind, value, reason) VALUES ('email_domain', $1, 'โดเมนชั่วคราวที่เจอในเคสก่อน')`, [TEMP]);

  // สแปมคำเชิญ: อีเมลชั่วคราว + เชิญ 60 รายการ + ลิงก์ = 30 + 40 + 24 = 94 → ระงับอัตโนมัติ
  spam = await customer(t, 'promo-deal-88');
  await t.owner.query(`UPDATE users SET email = $1 WHERE id = $2`, [`deal@${TEMP}`, spam.owner]);
  await invites(spam, 60);
  // จ่ายเงินอยู่ คะแนนเท่ากัน แต่ระบบไม่ระงับเอง
  paid = await customer(t, 'paid-co', { plan: 'team_m', status: 'active' });
  await t.owner.query(`UPDATE users SET email = $1 WHERE id = $2`, [`buyer@${TEMP}`, paid.owner]);
  await invites(paid, 60);
  // สมัคร 7 บัญชีจาก IP เดียว ไม่มีใครยืนยันอีเมล ครึ่งหนึ่งใช้โดเมนชั่วคราว = 35 + 30 + 20 = 85 → รอตรวจ
  for (let i = 1; i <= 7; i++) {
    const email = i <= 4 ? `test-${i}@${TEMP}` : `test-${i}@mail${i}.example.com`;
    const u = (await t.owner.query(`INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id`, [email, `test-${i}`])).rows[0].id;
    await t.owner.query(`INSERT INTO signup_attributions (user_id, signup_ip, created_at) VALUES ($1, $2, now() - interval '20 minutes')`, [u, IP]);
    if (i <= 2) {
      const w = (await t.owner.query(`INSERT INTO workspaces (slug, name) VALUES ($1, $1) RETURNING id`, [`test-0${i}`])).rows[0].id;
      await t.owner.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [w, u]);
    }
  }
  // ลูกค้าปกติ: เชิญเพื่อนร่วมโดเมนเดียวกัน 60 คน = ไม่ใช่ "ภายนอก"
  const ok = await customer(t, 'normal-team');
  for (let i = 0; i < 60; i++) {
    await t.owner.query(`INSERT INTO invitations (workspace_id, email, token_hash, expires_at, invited_by) VALUES ($1, $2, $3, now() + interval '7 days', $4)`, [ok.id, `m${i}@normal-team.example.com`, randomUUID(), ok.owner]);
  }
});
afterAll(() => t.close());

describe('ตรวจจับการใช้ผิด', () => {
  let spamCase: string;
  let paidCase: string;
  let ipCase: string;

  it('ให้คะแนนและเปิดเคส · ถึง 90 ระงับ Workspace ที่ไม่ได้จ่ายเงินแบบปิดทั้งหมด + อีเมลลูกค้า · สแกนซ้ำไม่เปิดเคสซ้ำ', async () => {
    const mail = t.app.get(Mailer);
    const before = mail.sent.length;
    expect(await svc.tick()).toMatchObject({ opened: 3, suspended: 1, reminded: 0 });
    const todo = (await eng.agent.get('/ops/abuse/cases?tab=todo').expect(200)).body;
    expect(todo.total).toBe(3);
    expect(todo.items.map((c: { score: number }) => c.score)).toEqual([94, 94, 85]);
    const bySubject = Object.fromEntries(todo.items.map((c: { label: string; id: string }) => [c.label, c]));
    spamCase = bySubject['Co promo-deal-88 (promo-deal-88)'].id;
    paidCase = bySubject['Co paid-co (paid-co)'].id;
    ipCase = bySubject['7 บัญชีจาก IP เดียว'].id;
    expect(bySubject['Co promo-deal-88 (promo-deal-88)']).toMatchObject({ kind: 'invite_spam', status: 'auto_suspended', confirmBy: expect.any(String) });
    expect(bySubject['Co paid-co (paid-co)'].status).toBe('open');
    expect(bySubject['7 บัญชีจาก IP เดียว']).toMatchObject({ kind: 'fake_signup', status: 'open', workspaces: 2, users: 7 });
    const ws = await t.owner.query(`SELECT slug, status, suspension_mode FROM workspaces WHERE slug IN ('promo-deal-88', 'paid-co') ORDER BY slug`);
    expect(ws.rows).toEqual([{ slug: 'paid-co', status: 'trial', suspension_mode: null }, { slug: 'promo-deal-88', status: 'suspended', suspension_mode: 'full' }]);
    expect(mail.sent.slice(before)).toEqual([expect.objectContaining({ to: `deal@${TEMP}`, subject: expect.stringContaining('ถูกระงับชั่วคราว'), text: expect.stringContaining('ตรวจใหม่') })]);
    const log = await t.owner.query(`SELECT actor_kind, summary FROM audit_logs WHERE workspace_id = $1 AND action = 'ops.workspace_suspended'`, [spam.id]);
    expect(log.rows).toEqual([{ actor_kind: 'system', summary: expect.stringContaining('ระงับอัตโนมัติ') }]);
    expect(await svc.scan()).toEqual({ opened: 0, updated: 0, suspended: 0 });
  });

  it('สิทธิ์: Support ไม่เห็น · ตัวเลขหัวหน้าและแถบต้องทำ · ตัวนับในภาพรวม', async () => {
    expect((await sam.agent.get('/ops/abuse/cases')).status).toBe(403);
    const sum = (await boss.agent.get('/ops/abuse/summary').expect(200)).body;
    expect(sum).toMatchObject({ autoSuspended7d: 1, falsePositivePct: null, todo: { open: 2, autoSuspended: 1, oldestAt: expect.any(String) }, tabs: { history: 0, blocks: 1 } });
    expect((await boss.agent.get('/ops/overview').expect(200)).body.tasks.abuseOpen).toBe(3);
  });

  it('แผงขวา: ที่มาของคะแนนและข้อมูล Workspace ที่ใช้ตัดสิน', async () => {
    const d = (await eng.agent.get(`/ops/abuse/cases/${spamCase}`).expect(200)).body;
    expect(d.signals.map((x: { rule: string; points: number }) => [x.rule, x.points])).toEqual([
      ['temp_email', 30],
      ['invite_burst', 40],
      ['invite_links', 24],
    ]);
    expect(d.signals[1].detail).toContain('(60)');
    expect(d.signals[2].detail).toContain('2 โดเมน');
    expect(d.workspaces).toEqual([expect.objectContaining({ slug: 'promo-deal-88', status: 'suspended', plan: 'team_s', paying: false, paidEver: false, members: 1, pendingInvites: 60, projects: 0, ownerEmail: `deal@${TEMP}` })]);
    const ip = (await eng.agent.get(`/ops/abuse/cases/${ipCase}`).expect(200)).body;
    expect(ip).toMatchObject({ ip: IP, userTotal: 7, workspaceTotal: 2, blockable: { ip: IP, domains: [TEMP] } });
    expect(ip.signals.find((x: { rule: string }) => x.rule === 'temp_email').detail).toContain('4/7');
  });

  it('ค้นหาและกรองที่ server', async () => {
    expect((await eng.agent.get('/ops/abuse/cases?q=paid-co')).body.items.map((c: { id: string }) => c.id)).toEqual([paidCase]);
    expect((await eng.agent.get(`/ops/abuse/cases?q=${IP}`)).body.total).toBe(1);
    expect((await eng.agent.get(`/ops/abuse/cases?q=test-6@mail6`)).body.total).toBe(1);
    expect((await eng.agent.get('/ops/abuse/cases?kind=fake_signup')).body.total).toBe(1);
    expect((await eng.agent.get('/ops/abuse/cases?minScore=90&limit=1')).body).toMatchObject({ total: 2, items: [expect.anything()] });
    expect((await eng.agent.get('/ops/abuse/cases?kind=bogus')).status).toBe(400);
  });

  it('ระงับอัตโนมัติเกิน 24 ชม. แจ้ง Owner ซ้ำทุก 24 ชม. แต่ไม่ปลดเอง', async () => {
    const mail = t.app.get(Mailer);
    const before = mail.sent.length;
    const later = new Date(Date.now() + 25 * 3_600_000);
    expect(await svc.remind(later)).toBe(1);
    expect(mail.sent.slice(before)).toEqual([expect.objectContaining({ to: 'boss@friday.example.com', subject: expect.stringContaining('ยังไม่มีคนยืนยัน') })]);
    expect(await svc.remind(later)).toBe(0);
    expect(await svc.remind(new Date(later.getTime() + 25 * 3_600_000))).toBe(1);
    expect((await t.owner.query(`SELECT status FROM workspaces WHERE id = $1`, [spam.id])).rows[0].status).toBe('suspended');
  });

  it('ตัดสินต้องแตะกุญแจ · Workspace ที่จ่ายเงินอยู่ระงับจากที่นี่ไม่ได้', async () => {
    const body = { ids: [paidCase], action: 'suspend', reason: 'สแปมคำเชิญ' };
    expect((await eng.agent.post('/ops/abuse/cases/decide').send(body)).body.error.code).toBe('reauth_required');
    await reauth(eng);
    expect((await eng.agent.post('/ops/abuse/cases/decide').send(body)).body.error.code).toBe('paying_workspace');
    expect((await eng.agent.post('/ops/abuse/cases/decide').send({ ...body, reason: 'x' })).status).toBe(400);
  });

  it('ไม่ใช่การใช้ผิด: ปลด Workspace ที่ระบบระงับ · ไม่เปิดเคสเรื่องเดิมซ้ำ 30 วัน · บอกเคสถัดไป', async () => {
    const r = (await eng.agent.post('/ops/abuse/cases/decide').send({ ids: [spamCase], action: 'dismiss', reason: 'ลูกค้าจริง ทีมการตลาดเชิญลูกค้าเอง' }).expect(201)).body;
    expect(r).toMatchObject({ decided: 1, outcome: 'dismissed', next: paidCase });
    expect((await t.owner.query(`SELECT status, suspension_mode FROM workspaces WHERE id = $1`, [spam.id])).rows[0]).toEqual({ status: 'trial', suspension_mode: null });
    expect((await t.owner.query(`SELECT summary FROM audit_logs WHERE workspace_id = $1 AND action = 'ops.workspace_resumed'`, [spam.id])).rows[0].summary).toContain('[Friday วิศวกร เอ]');
    expect((await svc.scan()).opened).toBe(0);
    expect((await eng.agent.post('/ops/abuse/cases/decide').send({ ids: [spamCase], action: 'suspend', reason: 'ตัดสินซ้ำ' })).body.error.code).toBe('case_closed');
  });

  it('ลบและบล็อก: ลบแบบกู้คืนได้ 30 วัน · บล็อก IP 90 วัน + โดเมนชั่วคราวถาวร', async () => {
    const r = (await eng.agent.post('/ops/abuse/cases/decide').send({ ids: [ipCase], action: 'block', reason: 'สมัครปลอมเป็นชุด' }).expect(201)).body;
    // โดเมน tempmail.example ถูกบล็อกอยู่แล้ว (เพิ่มตอนเริ่ม) จึงเพิ่มเฉพาะ IP
    expect(r.blocks).toEqual([{ kind: 'ip', value: IP }]);
    const ws = await t.owner.query(`SELECT status, purge_after > now() + interval '29 days' AS later FROM workspaces WHERE slug IN ('test-01', 'test-02')`);
    expect(ws.rows).toEqual([{ status: 'pending_delete', later: true }, { status: 'pending_delete', later: true }]);
    const b = (await eng.agent.get(`/ops/abuse/blocks?kind=ip`).expect(200)).body;
    expect(b.items).toEqual([expect.objectContaining({ value: IP, createdBy: 'วิศวกร เอ', caseNumber: expect.any(Number), expiresAt: expect.any(String) })]);
  });

  it('ประวัติ: กรองผล / คนตัดสิน / ช่วงวัน · % จับผิดของกฎ', async () => {
    const h = (await boss.agent.get('/ops/abuse/cases?tab=history').expect(200)).body;
    expect(h.items.map((c: { outcome: string }) => c.outcome)).toEqual(['blocked', 'dismissed']);
    expect(h.items[0].decidedBy).toBe('วิศวกร เอ');
    expect((await boss.agent.get('/ops/abuse/cases?tab=history&outcome=dismissed')).body.total).toBe(1);
    expect((await boss.agent.get(`/ops/abuse/cases?tab=history&decidedBy=${boss.id}`)).body.total).toBe(0);
    expect((await boss.agent.get('/ops/abuse/cases?tab=history&from=2020-01-01&to=2020-01-31')).body.total).toBe(0);
    const rules = (await boss.agent.get('/ops/abuse/rules').expect(200)).body;
    const by = Object.fromEntries(rules.rules.map((x: { key: string }) => [x.key, x]));
    expect(by.invite_burst).toMatchObject({ points: 40, on: true, hits7d: 2, falsePositivePct: 100 });
    expect(by.ip_burst).toMatchObject({ hits7d: 1, falsePositivePct: 0 });
    expect(by.card_declines).toMatchObject({ on: false, waiting: 'A35b' });
    expect((await boss.agent.get('/ops/abuse/summary')).body.falsePositivePct).toBe(50);
  });

  it('ปรับกฎ: แตะกุญแจ · กฎที่ยังไม่มีข้อมูลเปิดไม่ได้ · เกณฑ์ระงับต้องสูงกว่ารอตรวจ', async () => {
    const cur = (await boss.agent.get('/ops/abuse/rules')).body;
    const rules = Object.fromEntries(cur.rules.map((x: { key: string; points: number; on: boolean }) => [x.key, { points: x.points, on: x.on }]));
    const body = { review: 60, autoSuspend: 95, rules: { ...rules, geo_mismatch: { points: 15, on: false }, invite_links: { points: 10, on: true } } };
    expect((await boss.agent.put('/ops/abuse/rules').send(body)).body.error.code).toBe('reauth_required');
    await reauth(boss);
    expect((await boss.agent.put('/ops/abuse/rules').send({ ...body, autoSuspend: 50 })).status).toBe(400);
    expect((await boss.agent.put('/ops/abuse/rules').send({ ...body, rules: { ...body.rules, card_declines: { points: 45, on: true } } })).body.error.code).toBe('rule_unavailable');
    const saved = (await boss.agent.put('/ops/abuse/rules').send(body).expect(200)).body;
    expect(saved).toMatchObject({ saved: true, review: 60, autoSuspend: 95 });
    expect(saved.rules.find((x: { key: string }) => x.key === 'invite_links').points).toBe(10);
    const log = await t.owner.query(`SELECT reason FROM staff_audit_logs WHERE action = 'abuse.rules_updated'`);
    expect(log.rows[0].reason).toContain('เกณฑ์รอตรวจ 70 → 60');
  });

  it('รายชื่อที่ถูกบล็อก: เพิ่ม / ค้น / เลิกบล็อก · ตรวจรูปแบบ IP · token ถูกยกเลิกทันที', async () => {
    await reauth(eng);
    expect((await eng.agent.post('/ops/abuse/blocks').send({ kind: 'ip', value: '203.0.113.0/4', reason: 'กว้างเกิน' })).status).toBe(400);
    expect((await eng.agent.post('/ops/abuse/blocks').send({ kind: 'email_domain', value: 'not a domain', reason: 'ผิดรูป' })).status).toBe(400);
    const r = (await eng.agent.post('/ops/abuse/blocks').send({ kind: 'ip', value: '198.51.100.0/24', reason: 'บอทสมัครเป็นชุด', expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }).expect(201)).body;
    expect((await eng.agent.post('/ops/abuse/blocks').send({ kind: 'ip', value: '198.51.100.0/24', reason: 'ซ้ำ' })).body.error.code).toBe('already_blocked');
    await eng.agent.post('/ops/abuse/blocks').send({ kind: 'workspace_slug', value: 'Free-Money', reason: 'ชื่อหลอกลวง' }).expect(201);
    const tok = (await t.owner.query(`INSERT INTO api_tokens (workspace_id, name, token_hash, created_by) VALUES ($1, 'ci-bot', $2, $3) RETURNING id`, [paid.id, randomUUID(), paid.owner])).rows[0].id;
    await eng.agent.post('/ops/abuse/blocks').send({ kind: 'api_token', value: tok, reason: 'เรียกวนซ้ำ' }).expect(201);
    expect((await t.owner.query(`SELECT revoked_at IS NOT NULL AS revoked FROM api_tokens WHERE id = $1`, [tok])).rows[0].revoked).toBe(true);
    expect((await t.owner.query(`SELECT summary FROM audit_logs WHERE workspace_id = $1 AND action = 'ops.api_token_blocked'`, [paid.id])).rows[0].summary).toContain('Co paid-co · ci-bot');
    expect((await eng.agent.get('/ops/abuse/blocks?q=free-money')).body.items).toEqual([expect.objectContaining({ kind: 'workspace_slug', value: 'free-money' })]);
    expect((await eng.agent.get('/ops/abuse/blocks')).body.total).toBe(5);
    await eng.agent.post(`/ops/abuse/blocks/${r.id}/remove`).send({ reason: 'ปลดแล้ว' }).expect(201);
    expect((await eng.agent.post(`/ops/abuse/blocks/${r.id}/remove`).send({ reason: 'ซ้ำ' })).status).toBe(404);
    expect((await eng.agent.get('/ops/abuse/blocks')).body.total).toBe(4);
  });

  it('ขอยืนยันตัวตน: ระงับแบบอ่านอย่างเดียว + อีเมลขอเอกสาร · ระงับสแปมคำเชิญยกเลิกคำเชิญที่ค้าง', async () => {
    const mail = t.app.get(Mailer);
    // Workspace ใหม่ที่ไม่ได้จ่ายเงิน: ทำเคสด้วยมือเพื่อทดสอบผลการตัดสิน
    const a = await customer(t, 'verify-me');
    const b = await customer(t, 'spam-two');
    await invites(b, 3);
    const mk = async (c: Customer, kind: string) =>
      (await t.owner.query(`INSERT INTO abuse_cases (kind, subject, label, workspace_ids, score, signals) VALUES ($1, $2, $3, $4, 75, '[]') RETURNING id`, [kind, `ws:${c.id}`, c.slug, [c.id]])).rows[0].id;
    const va = await mk(a, 'fake_signup');
    const vb = await mk(b, 'invite_spam');
    const before = mail.sent.length;
    await eng.agent.post('/ops/abuse/cases/decide').send({ ids: [va], action: 'verify_identity', reason: 'ขอเอกสารบริษัท' }).expect(201);
    expect((await t.owner.query(`SELECT status, suspension_mode FROM workspaces WHERE id = $1`, [a.id])).rows[0]).toEqual({ status: 'suspended', suspension_mode: 'read_only' });
    expect(mail.sent.slice(before)).toEqual([expect.objectContaining({ to: 'owner@verify-me.example.com', text: expect.stringContaining('ยืนยันตัวตน') })]);
    await eng.agent.post('/ops/abuse/cases/decide').send({ ids: [vb], action: 'suspend', reason: 'สแปมคำเชิญ' }).expect(201);
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM invitations WHERE workspace_id = $1 AND status = 'pending'`, [b.id])).rows[0].n).toBe(0);
    expect((await t.owner.query(`SELECT suspension_mode FROM workspaces WHERE id = $1`, [b.id])).rows[0].suspension_mode).toBe('full');
  });
});
