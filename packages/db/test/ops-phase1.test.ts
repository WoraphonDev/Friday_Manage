// O00: ตาราง Friday Ops เฟส 1 และข้อมูลธุรกิจ · ทดสอบกับ PostgreSQL จริงด้วย role ที่ถูกบังคับ RLS
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ownerUrl = process.env.DATABASE_OWNER_URL ?? 'postgres://friday_owner:friday_owner_dev@localhost:54329/friday';
const appRole = 'friday_o00_app';
const urlFor = (role: string) => {
  const u = new URL(ownerUrl);
  u.username = role;
  u.password = role;
  return u.toString();
};
const owner = new pg.Client({ connectionString: ownerUrl });
const app = new pg.Client({ connectionString: urlFor(appRole) });
// ops-api ใช้ friday_worker (BYPASSRLS ที่ตัว role · ดู scripts/dev-roles.ts)
const sys = new pg.Client({ connectionString: process.env.DATABASE_SYSTEM_URL ?? 'postgres://friday_worker:friday_worker_dev@localhost:54329/friday' });
const U = { lead: randomUUID(), other: randomUUID() };
const W = { one: randomUUID(), two: randomUUID() };

const opsOnly = [
  'staff_elevations', 'approval_requests', 'staff_audit_logs', 'support_tickets', 'support_ticket_messages', 'status_subscribers',
  'dunning_events', 'signup_attributions', 'workspace_acquisitions', 'daily_usages', 'cost_rates', 'infra_costs', 'marketing_costs',
];

// table / column เป็นค่าคงที่จาก fixture เท่านั้น ส่วนข้อมูลใช้ parameters เสมอ
async function insert(table: string, data: Record<string, unknown>, client: pg.Client = owner, returning = 'id'): Promise<string> {
  const keys = Object.keys(data);
  const { rows } = await client.query(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${returning}`,
    Object.values(data),
  );
  return rows[0]?.[returning];
}

async function as<T>(user: string | null, ws: string | null, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  await app.query('BEGIN');
  try {
    await app.query(`SELECT set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)`, [user ?? '', ws ?? '']);
    return await fn(app);
  } finally {
    await app.query('ROLLBACK');
  }
}

const rows = async (client: pg.Client, sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;

let staff: { owner: string; finance: string };
let invoice: { one: string; two: string };

async function seedInvoice(ws: string, suffix: string) {
  const plan = await insert('plans', { code: `o00-${suffix}`, seat_limit: 10 });
  const subscription = await insert('subscriptions', { workspace_id: ws, plan_id: plan });
  return insert('invoices', { workspace_id: ws, subscription_id: subscription, number: `INV-O00-${suffix}`, period_start: '2026-11-01', period_end: '2026-11-30', subtotal: 10000, vat: 700, total: 10700, amount_due: 10700, due_date: '2026-11-30' });
}

beforeAll(async () => {
  await owner.connect();
  await owner.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${appRole}') THEN
    CREATE ROLE ${appRole} LOGIN PASSWORD '${appRole}' IN ROLE friday_app; END IF; END $$`);
  const tables = (await owner.query(`SELECT string_agg(format('public.%I', tablename), ', ') AS t FROM pg_tables WHERE schemaname = 'public'`)).rows[0].t;
  await owner.query(`TRUNCATE ${tables} CASCADE`);
  for (const [name, id] of Object.entries(U)) await insert('users', { id, email: `${name}@o00.example.com`, display_name: name });
  await insert('workspaces', { id: W.one, slug: 'o00-one', name: 'ทดสอบหนึ่ง' });
  await insert('workspaces', { id: W.two, slug: 'o00-two', name: 'ทดสอบสอง' });
  await owner.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $3, 'owner'), ($2, $4, 'owner')`, [W.one, W.two, U.lead, U.other]);
  staff = {
    owner: await insert('staff_users', { email: 'owner@o00.example.com', name: 'Owner', roles: ['owner', 'finance'] }),
    finance: await insert('staff_users', { email: 'finance@o00.example.com', name: 'Finance', roles: ['finance'] }),
  };
  invoice = { one: await seedInvoice(W.one, '1'), two: await seedInvoice(W.two, '2') };
  for (const [ws, inv, n] of [[W.one, invoice.one, '1'], [W.two, invoice.two, '2']]) {
    const note = await insert('credit_notes', { workspace_id: ws, invoice_id: inv, number: `CN-O00-${n}`, kind: 'credit', amount_satang: 500, reason: 'ทดสอบ' });
    await insert('workspace_credits', { workspace_id: ws, amount_satang: 500, source: 'credit_note', credit_note_id: note });
    await insert('product_events', { workspace_id: ws, name: 'feature.used', props: { feature: 'gantt' } });
    await insert('subscription_changes', { workspace_id: ws, kind: 'new', plan_to: 'team_s', mrr_before_satang: 0, mrr_after_satang: 100000, actor_kind: 'user', effective_at: new Date() });
  }
  await insert('incidents', { title: 'เผยแพร่แล้ว', status: 'monitoring' });
  await insert('incidents', { title: 'บันทึกภายใน', internal: true });
  await insert('maintenance_windows', { message: 'ปรับปรุง', starts_at: '2026-11-15T16:00:00Z', ends_at: '2026-11-15T18:00:00Z' });
  await insert('staff_audit_logs', { staff_id: staff.owner, action: 'staff.invite', reason: 'ทดสอบ' });
  await app.connect();
  await sys.connect();
});

afterAll(async () => {
  await app.end();
  await sys.end();
  await owner.end();
});

describe('บทบาทพนักงาน (06-ops-roles)', () => {
  it('ต้องมีอย่างน้อย 1 บทบาท และใช้ได้เฉพาะบทบาทที่กำหนด', async () => {
    await expect(insert('staff_users', { email: 'none@o00.example.com', name: 'ไม่มีบทบาท' })).rejects.toThrow(/staff_users_roles_valid/);
    await expect(insert('staff_users', { email: 'bad@o00.example.com', name: 'ผิด', roles: ['superuser'] })).rejects.toThrow(/staff_users_roles_valid/);
    await expect(insert('staff_users', { email: 'st@o00.example.com', name: 'ผิด', roles: ['support'], status: 'gone' })).rejects.toThrow(/staff_users_status_valid/);
  });

  it('สิทธิ์ฉุกเฉินเปิดได้ไม่เกิน 1 ชั่วโมง', async () => {
    const now = Date.now();
    await insert('staff_elevations', { staff_id: staff.owner, role: 'engineer', reason: 'ระบบล่ม', started_at: new Date(now), ends_at: new Date(now + 3600_000) });
    await expect(insert('staff_elevations', { staff_id: staff.owner, role: 'engineer', reason: 'นานเกิน', started_at: new Date(now), ends_at: new Date(now + 2 * 3600_000) }))
      .rejects.toThrow(/staff_elevations_window/);
  });

  it('ผู้ขออนุมัติตัวเองไม่ได้ ยกเว้นติด self_approved', async () => {
    const base = { kind: 'refund', requested_by: staff.owner, reason: 'โอนซ้ำ', expires_at: new Date(Date.now() + 86400_000) };
    await expect(insert('approval_requests', { ...base, status: 'approved', decided_by: staff.owner })).rejects.toThrow(/approval_requests_self/);
    await insert('approval_requests', { ...base, status: 'approved', decided_by: staff.owner, self_approved: true });
    await insert('approval_requests', { ...base, status: 'approved', decided_by: staff.finance });
    await expect(insert('approval_requests', { ...base, status: 'approved' })).rejects.toThrow(/approval_requests_decision/);
  });

  it('Audit log ของทีม Friday แก้ / ลบไม่ได้แม้ใช้ role ของ ops', async () => {
    await insert('staff_audit_logs', { action: 'staff.update', reason: 'เปลี่ยนบทบาท' }, sys);
    await expect(sys.query(`UPDATE staff_audit_logs SET reason = 'แก้'`)).rejects.toThrow(/permission denied/);
    await expect(sys.query(`DELETE FROM staff_audit_logs`)).rejects.toThrow(/permission denied/);
  });

  it('เข้าบัญชีลูกค้าโหมดแก้ไขยังต้องมีผู้อนุมัติคนที่สองเสมอ', async () => {
    await expect(insert('support_sessions', { workspace_id: W.one, staff_id: staff.owner, ticket_no: '#1', reason: 'ทดสอบ', mode: 'write', second_approver_id: staff.owner }))
      .rejects.toThrow(/support_sessions_write_approval/);
  });
});

describe('สิทธิ์ของแอปลูกค้า', () => {
  it.each(opsOnly)('%s ห้ามลูกค้าอ่านและเขียน', async (table) => {
    await as(U.lead, W.one, async (c) => {
      await expect(c.query(`SELECT 1 FROM ${table} LIMIT 1`)).rejects.toThrow(/permission denied/);
    });
  });

  it.each(['product_events', 'subscription_changes'])('%s เห็นเฉพาะ Workspace ปัจจุบันและแก้ / ลบไม่ได้', async (table) => {
    await as(U.lead, W.one, async (c) => {
      const found = await rows(c, `SELECT workspace_id FROM ${table}`);
      expect(found.length).toBe(1);
      expect(found[0].workspace_id).toBe(W.one);
      await expect(c.query(`DELETE FROM ${table}`)).rejects.toThrow(/permission denied/);
    });
  });

  it('เขียนเหตุการณ์ในแอปได้เฉพาะ Workspace ปัจจุบัน', async () => {
    await as(U.lead, W.one, async (c) => {
      await insert('product_events', { workspace_id: W.one, user_id: U.lead, name: 'limit.hit', props: { limit: 'seats' } }, c);
      await expect(insert('product_events', { workspace_id: W.two, name: 'feature.used' }, c)).rejects.toThrow(/row-level security/);
    });
  });

  it('แบบสอบถามตอนยกเลิกเขียนได้ในบริบทของ Workspace', async () => {
    await as(U.lead, W.one, async (c) => {
      await insert('cancellation_responses', { workspace_id: W.one, user_id: U.lead, reason: 'too_expensive', outcome: 'kept' }, c);
      await expect(insert('cancellation_responses', { workspace_id: W.one, reason: 'bored', outcome: 'kept' }, c)).rejects.toThrow(/cancellation_responses_reason_valid/);
    });
  });

  it.each(['credit_notes', 'workspace_credits'])('%s ลูกค้าอ่านของตัวเองได้แต่เขียนไม่ได้', async (table) => {
    await as(U.lead, W.one, async (c) => {
      const found = await rows(c, `SELECT workspace_id FROM ${table}`);
      expect(found.map((r) => r.workspace_id)).toEqual([W.one]);
      await expect(c.query(`DELETE FROM ${table}`)).rejects.toThrow(/permission denied/);
    });
  });

  it('เห็นเหตุขัดข้องที่เผยแพร่และช่วงปิดปรับปรุง แต่ไม่เห็นบันทึกภายใน', async () => {
    await as(U.lead, W.one, async (c) => {
      expect((await rows(c, 'SELECT title FROM incidents')).map((r) => r.title)).toEqual(['เผยแพร่แล้ว']);
      expect(await rows(c, 'SELECT id FROM maintenance_windows')).toHaveLength(1);
      await expect(c.query(`UPDATE maintenance_windows SET status = 'cancelled'`)).rejects.toThrow(/permission denied/);
    });
  });
});

describe('เงิน', () => {
  it('ใบลดหนี้ต้องอ้างใบแจ้งหนี้ใน Workspace เดียวกัน', async () => {
    await expect(insert('credit_notes', { workspace_id: W.one, invoice_id: invoice.two, number: 'CN-O00-X', kind: 'refund', amount_satang: 100, reason: 'ข้าม tenant' }))
      .rejects.toThrow(/credit_notes_invoice_fk/);
  });

  it('เครดิตที่ใช้หักต้องติดลบ · ได้เครดิตต้องเป็นบวก', async () => {
    await insert('workspace_credits', { workspace_id: W.one, amount_satang: -200, source: 'applied', invoice_id: invoice.one });
    await expect(insert('workspace_credits', { workspace_id: W.one, amount_satang: 200, source: 'applied' })).rejects.toThrow(/workspace_credits_applied_negative/);
  });

  it('คิวกรณีผิดปกติใช้ exception_reason ที่กำหนด · ผูกใบแจ้งหนี้ข้าม Workspace ไม่ได้', async () => {
    const pay = { workspace_id: W.one, invoice_id: invoice.one, method: 'transfer', amount: 10700 };
    await insert('payments', { ...pay, exception_reason: 'duplicate_slip', provider_ref: 'o00-1' });
    await expect(insert('payments', { ...pay, exception_reason: 'weird', provider_ref: 'o00-2' })).rejects.toThrow(/payments_exception_reason_valid/);
    await expect(insert('payments', { ...pay, matched_invoice_id: invoice.two, provider_ref: 'o00-3' })).rejects.toThrow(/payments_matched_invoice_fk/);
  });
});

describe('ข้อมูลธุรกิจ', () => {
  it('ต้นทุนต่อหน่วยต้องมีค่าอย่างใดอย่างหนึ่ง (บาทต่อหน่วย หรือ %)', async () => {
    await insert('cost_rates', { resource: 'line_message', unit_cost_satang: 4.5, effective_from: '2026-10-01' });
    await insert('cost_rates', { resource: 'payment_fee_promptpay', pct: 1.65, effective_from: '2026-10-01' });
    await expect(insert('cost_rates', { resource: 'email', effective_from: '2026-10-01' })).rejects.toThrow(/cost_rates_one_value/);
  });

  it('ค่าใช้จ่ายรายเดือนใช้วันที่ 1 ของเดือน', async () => {
    await insert('marketing_costs', { month: '2026-11-01', source: 'google', amount_satang: 4800000 }, owner, 'source');
    await expect(insert('marketing_costs', { month: '2026-11-15', source: 'facebook', amount_satang: 1 }, owner, 'source')).rejects.toThrow(/marketing_costs_first_day/);
  });

  it('ยอดใช้รายวันมีได้ 1 แถวต่อ Workspace ต่อวัน', async () => {
    await insert('daily_usages', { workspace_id: W.one, date: '2026-11-09', line_messages: 10 }, owner, 'date');
    await expect(insert('daily_usages', { workspace_id: W.one, date: '2026-11-09' }, owner, 'date')).rejects.toThrow(/duplicate key/);
  });
});
