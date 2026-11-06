// ทดสอบด้วย role ที่ถูกบังคับ RLS จริง ทั้ง SELECT และการเขียนที่พยายามข้ามสิทธิ์
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ownerUrl = process.env.DATABASE_OWNER_URL ?? 'postgres://friday_owner:friday_owner_dev@localhost:54329/friday';
const role = 'friday_t00_test';
const appUrl = new URL(ownerUrl);
appUrl.username = role;
appUrl.password = role;
const owner = new pg.Client({ connectionString: ownerUrl });
const app = new pg.Client({ connectionString: appUrl.toString() });
const U = { lead: randomUUID(), member: randomUUID(), other: randomUUID(), admin: randomUUID() };
const W = { one: randomUUID(), two: randomUUID() };
const tenantTables = [
  'calendar_feed_tokens', 'sso_connections', 'verified_domains', 'project_templates',
  'git_installations', 'git_repositories', 'project_repositories', 'git_commits', 'pull_requests', 'issue_git_links',
  'notification_deliveries', 'user_notification_prefs', 'user_notification_settings', 'line_oa_configs', 'line_groups',
  'email_sender_configs', 'webhook_endpoints', 'project_notification_rules', 'project_notification_settings', 'report_schedules',
  'automation_rules', 'automation_runs', 'saved_views', 'saved_searches', 'api_tokens', 'data_subject_requests', 'workspace_exports',
  'subscriptions', 'billing_profiles', 'invoices', 'payments', 'tax_documents', 'wht_certificates',
  'support_access_grants',
];
const projectTables = ['project_repositories', 'project_notification_rules', 'project_notification_settings', 'report_schedules', 'automation_rules', 'automation_runs', 'saved_views', 'git_commits', 'pull_requests', 'issue_git_links'];
const personalTables = ['line_bindings', 'line_link_codes', 'calendar_feed_tokens', 'user_notification_prefs', 'user_notification_settings', 'saved_searches', 'legal_acceptances'];

// table / column เป็นค่าคงที่จาก fixture เท่านั้น ส่วนข้อมูลใช้ parameters เสมอ
async function insert(table: string, data: Record<string, unknown>, client = owner): Promise<string> {
  const keys = Object.keys(data);
  const { rows } = await client.query(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(data));
  return rows[0].id;
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

async function seedProject(ws: string, user: string, key: string) {
  const project = await insert('projects', { workspace_id: ws, key, name: key, owner_user_id: user, start_date: '2026-11-05', golive_date: '2027-04-21', visibility: 'private' });
  const workflow = await insert('workflows', { workspace_id: ws, project_id: project, name: 'มาตรฐาน' });
  const status = await insert('workflow_statuses', { workspace_id: ws, project_id: project, workflow_id: workflow, name: 'To do', category: 'todo' });
  const type = await insert('issue_types', { workspace_id: ws, project_id: project, workflow_id: workflow, name: 'Task' });
  const issue = await insert('issues', { workspace_id: ws, project_id: project, number: 1, issue_type_id: type, status_id: status, title: 'ทดสอบ RLS' });
  return { project, issue };
}

async function seedTenant(ws: string, user: string, suffix: string) {
  const p = await seedProject(ws, user, `P${suffix}`);
  const w = { workspace_id: ws };
  const wp = { ...w, project_id: p.project };
  await insert('calendar_feed_tokens', { ...wp, user_id: user, token_hash: `calendar-${suffix}` });
  await insert('sso_connections', { ...w, type: 'oidc', config_encrypted: 'ciphertext', config_last4: 'fake' });
  await insert('verified_domains', { ...w, domain: `t00-${suffix}.example.com`, dns_token: `dns-${suffix}` });
  await insert('project_templates', { ...w, name: 'แม่แบบ' });
  const installation = await insert('git_installations', { ...w, provider: 'github', account_name: 'test', external_installation_id: suffix });
  const repository = await insert('git_repositories', { ...w, installation_id: installation, full_name: 'example/test' });
  await insert('project_repositories', { ...wp, repository_id: repository });
  const commit = await insert('git_commits', { ...w, repository_id: repository, sha: `sha-${suffix}`, message: 'ทดสอบ', committed_at: new Date(), url: 'https://example.com/commit' });
  const pr = await insert('pull_requests', { ...w, repository_id: repository, number: 1, title: 'ทดสอบ', source_branch: 'feature', target_branch: 'main', url: 'https://example.com/pr/1' });
  const link = await insert('issue_git_links', { ...w, issue_id: p.issue, commit_id: commit, link_source: 'manual' });
  const notification = await insert('notifications', { ...w, recipient_id: user, event_type: 'issue.created', payload: '{}' });
  await insert('notification_deliveries', { ...w, notification_id: notification, channel: 'email', target_ref: 'test@example.com' });
  await insert('user_notification_prefs', { ...w, user_id: user, event_type: 'issue.created', channel: 'email' });
  await insert('user_notification_settings', { ...w, user_id: user });
  await insert('line_oa_configs', { ...w, channel_id: suffix, channel_secret_encrypted: 'ciphertext', channel_secret_last4: 'fake', access_token_encrypted: 'ciphertext', access_token_last4: 'fake' });
  const group = await insert('line_groups', { ...w, line_group_id: suffix, name: 'กลุ่มทดสอบ' });
  await insert('email_sender_configs', { ...w, from_name: 'ทดสอบ', from_email: 'test@example.com' });
  const webhook = await insert('webhook_endpoints', { ...w, name: 'ทดสอบ', url_encrypted: 'ciphertext', url_last4: 'fake' });
  await insert('project_notification_rules', { ...wp, event_type: 'issue.created', line_group_id: group });
  await insert('project_notification_settings', wp);
  await insert('report_schedules', { ...wp, report_type: 'weekly', weekday: 5 });
  const rule = await insert('automation_rules', { ...wp, name: 'กฎทดสอบ', trigger: 'issue_created', created_by: user });
  const run = await insert('automation_runs', { ...w, rule_id: rule, issue_ids: [p.issue], result: 'success' });
  const view = await insert('saved_views', { ...wp, name: 'แชร์ทั้งโปรเจกต์' });
  await insert('saved_views', { ...wp, name: 'ส่วนตัว', owner_id: user });
  await insert('saved_searches', { ...w, user_id: user, name: 'ส่วนตัว', query: 'ทดสอบ' });
  await insert('api_tokens', { ...w, name: 'ทดสอบ', token_hash: `api-${suffix}`, created_by: user });
  await insert('data_subject_requests', { ...w, requester_email: 'test@example.com', request_type: 'export', due_date: '2026-12-05' });
  await insert('workspace_exports', { ...w, requested_by: user });
  const plan = await insert('plans', { code: `fixture-${suffix}`, seat_limit: 10 });
  const subscription = await insert('subscriptions', { ...w, plan_id: plan });
  await insert('billing_profiles', { ...w, company_name: 'ทดสอบ', tax_id: '0000000000000', address: 'ทดสอบ', tax_email: 'test@example.com' });
  const invoice = await insert('invoices', { ...w, subscription_id: subscription, number: `INV-${suffix}`, period_start: '2026-11-01', period_end: '2026-11-30', subtotal: 10000, vat: 700, total: 10700, amount_due: 10700, due_date: '2026-11-30' });
  await insert('payments', { ...w, invoice_id: invoice, method: 'transfer', amount: 10700 });
  await insert('tax_documents', { ...w, invoice_id: invoice, doc_type: 'invoice', number: `TAX-${suffix}` });
  await insert('wht_certificates', { ...w, invoice_id: invoice, file_key: 'test.pdf', uploaded_by: user });
  await insert('support_access_grants', { ...w, granted_by: user });
  return { ...p, installation, repository, commit, pr, link, notification, group, webhook, rule, run, view, plan, subscription, invoice };
}

let one: Awaited<ReturnType<typeof seedTenant>>;
let two: Awaited<ReturnType<typeof seedTenant>>;
let hidden: Awaited<ReturnType<typeof seedProject>>;
let document: string;

beforeAll(async () => {
  await owner.connect();
  await owner.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    CREATE ROLE ${role} LOGIN PASSWORD '${role}' IN ROLE friday_app; END IF; END $$`);
  const tables = (await owner.query(`SELECT string_agg(format('public.%I', tablename), ', ') AS t FROM pg_tables WHERE schemaname = 'public'`)).rows[0].t;
  await owner.query(`TRUNCATE ${tables} CASCADE`);
  for (const [name, id] of Object.entries(U)) await insert('users', { id, email: `${name}@t00.example.com`, display_name: name });
  await insert('workspaces', { id: W.one, slug: 't00-one', name: 'ทดสอบหนึ่ง' });
  await insert('workspaces', { id: W.two, slug: 't00-two', name: 'ทดสอบสอง' });
  await owner.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
    ($1, $3, 'owner'), ($1, $4, 'member'), ($1, $6, 'admin'), ($2, $5, 'owner'), ($2, $3, 'member')`,
  [W.one, W.two, U.lead, U.member, U.other, U.admin]);
  one = await seedTenant(W.one, U.lead, '1');
  two = await seedTenant(W.two, U.other, '2');
  await owner.query(`INSERT INTO project_members (workspace_id, project_id, user_id, role) VALUES ($1, $2, $3, 'member')`, [W.one, one.project, U.member]);
  hidden = await seedProject(W.one, U.lead, 'HI');
  await insert('saved_views', { workspace_id: W.one, project_id: hidden.project, name: 'โปรเจกต์ลับ' });
  await insert('calendar_feed_tokens', { workspace_id: W.one, user_id: U.member, token_hash: 'calendar-member' });
  for (const user of [U.lead, U.member, U.other]) {
    await insert('line_bindings', { user_id: user, line_user_id: `line-${user}` });
    await insert('line_link_codes', { user_id: user, code_hash: `hash-${user}` });
  }
  document = await insert('legal_documents', { doc_type: 'terms', version: '1', effective_at: new Date(), summary: 'ทดสอบ', body: 'ข้อกำหนดทดสอบ' });
  for (const [user, ws] of [[U.lead, W.one], [U.member, W.one], [U.other, W.two]]) {
    await insert('legal_acceptances', { user_id: user, workspace_id: ws, document_id: document });
  }
  const staff = await insert('staff_users', { email: 'staff@example.com', name: 'ทดสอบ', role: 'support' });
  await insert('support_sessions', { workspace_id: W.one, staff_id: staff, ticket_no: 'T00', reason: 'ทดสอบ' });
  const flag = await insert('feature_flags', { key: 't00' });
  await insert('feature_flag_overrides', { flag_id: flag, workspace_id: W.one, enabled: true });
  await insert('announcements', { message: 'ทดสอบ' });
  await app.connect();
});

afterAll(async () => { await app.end(); await owner.end(); });

describe('แยก Workspace สำหรับทุกตารางใหม่ของลูกค้า', () => {
  it.each(tenantTables)('%s เห็นเฉพาะ Workspace ปัจจุบัน', async (table) => {
    await as(U.lead, W.one, async (client) => {
      const { rows } = await client.query(`SELECT workspace_id FROM ${table}`);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.workspace_id === W.one)).toBe(true);
    });
  });

  it('ไม่ตั้ง context / ไม่ใช่สมาชิก / สมาชิกถูกปิด → ไม่เห็น tenant data', async () => {
    for (const [user, ws] of [[null, null], [U.other, W.one]]) {
      await as(user, ws, async (client) => {
        for (const table of tenantTables) expect((await client.query(`SELECT id FROM ${table}`)).rows, table).toEqual([]);
      });
    }
    await owner.query(`UPDATE workspace_members SET status = 'deactivated' WHERE workspace_id = $1 AND user_id = $2`, [W.one, U.lead]);
    try {
      await as(U.lead, W.one, async (client) => {
        for (const table of tenantTables) expect((await client.query(`SELECT id FROM ${table}`)).rows, table).toEqual([]);
      });
    } finally {
      await owner.query(`UPDATE workspace_members SET status = 'active' WHERE workspace_id = $1 AND user_id = $2`, [W.one, U.lead]);
    }
  });

  it('เขียน row ไปอีก Workspace ไม่ได้ แม้ผู้ใช้เป็นสมาชิกทั้งคู่', async () => {
    await expect(as(U.lead, W.one, (client) => insert('project_templates', { workspace_id: W.two, name: 'ข้าม tenant' }, client))).rejects.toMatchObject({ code: '42501' });
    await expect(as(U.lead, W.one, (client) => client.query(`UPDATE project_templates SET workspace_id = $1 WHERE workspace_id = $2`, [W.two, W.one]))).rejects.toMatchObject({ code: '42501' });
  });
});

describe('โปรเจกต์และข้อมูลส่วนตัว', () => {
  it.each(projectTables)('%s ซ่อนข้อมูลโปรเจกต์จาก Workspace Admin ที่ยังไม่ได้เข้าร่วม', async (table) => {
    await as(U.admin, W.one, async (client) => expect((await client.query(`SELECT id FROM ${table}`)).rows).toEqual([]));
  });

  it.each(personalTables)('%s อ่านได้เฉพาะของตัวเอง', async (table) => {
    await as(U.lead, W.one, async (client) => {
      const { rows } = await client.query(`SELECT user_id FROM ${table}`);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.user_id === U.lead)).toBe(true);
    });
  });

  it('สมาชิกเห็น View ที่แชร์และของตนเอง แต่ไม่เห็นของคนอื่นหรือโปรเจกต์อื่น', async () => {
    await as(U.member, W.one, async (client) => {
      const own = await insert('saved_views', { workspace_id: W.one, project_id: one.project, owner_id: U.member, name: 'ของฉัน' }, client);
      expect((await client.query('SELECT id FROM saved_views ORDER BY id')).rows.map((row) => row.id).sort()).toEqual([one.view, own].sort());
      expect((await client.query('SELECT id FROM calendar_feed_tokens')).rows).toHaveLength(1);
    });
  });

  it('สร้างข้อมูลส่วนตัวแทนผู้อื่นหรือโอนเจ้าของไม่ได้', async () => {
    await expect(as(U.lead, W.one, (client) => insert('saved_searches', { workspace_id: W.one, user_id: U.member, name: 'แอบสร้าง', query: 'test' }, client))).rejects.toMatchObject({ code: '42501' });
    await expect(as(U.lead, W.one, (client) => client.query('UPDATE saved_searches SET user_id = $1', [U.member]))).rejects.toMatchObject({ code: '42501' });
    await expect(as(U.member, W.one, (client) => insert('saved_views', { workspace_id: W.one, project_id: hidden.project, name: 'แอบเข้าโปรเจกต์' }, client))).rejects.toMatchObject({ code: '42501' });
  });

  it('รับทราบกฎหมายก่อนมี Workspace ได้ แต่ผูก Workspace ของคนอื่นไม่ได้', async () => {
    await as(U.lead, null, async (client) => {
      await insert('legal_acceptances', { user_id: U.lead, document_id: document }, client);
      expect((await client.query('SELECT user_id, workspace_id FROM legal_acceptances')).rows).toEqual([{ user_id: U.lead, workspace_id: null }]);
    });
    await expect(as(U.other, W.one, (client) => insert('legal_acceptances', { user_id: U.other, workspace_id: W.one, document_id: document }, client))).rejects.toMatchObject({ code: '42501' });
  });
});

describe('FK กันการอ้างข้อมูลข้าม tenant แม้เขียนด้วยเจ้าของตารางที่ข้าม RLS', () => {
  const cases = () => [
    ['project template calendar', 'calendar_feed_tokens', { workspace_id: W.one, project_id: two.project, user_id: U.lead, token_hash: 'cross-calendar' }],
    ['repository installation', 'git_repositories', { workspace_id: W.one, installation_id: two.installation, full_name: 'cross/repo' }],
    ['project repository', 'project_repositories', { workspace_id: W.one, project_id: one.project, repository_id: two.repository }],
    ['issue commit', 'issue_git_links', { workspace_id: W.one, issue_id: one.issue, commit_id: two.commit, link_source: 'manual' }],
    ['notification delivery', 'notification_deliveries', { workspace_id: W.one, notification_id: two.notification, channel: 'email', target_ref: 'cross@example.com' }],
    ['project LINE group', 'project_notification_rules', { workspace_id: W.one, project_id: one.project, event_type: 'cross', line_group_id: two.group }],
    ['automation run', 'automation_runs', { workspace_id: W.one, rule_id: two.rule, result: 'success' }],
    ['invoice subscription', 'invoices', { workspace_id: W.one, subscription_id: two.subscription, number: 'CROSS', period_start: '2026-11-01', period_end: '2026-11-30', subtotal: 100, vat: 7, total: 107, amount_due: 107, due_date: '2026-11-30' }],
    ['payment invoice', 'payments', { workspace_id: W.one, invoice_id: two.invoice, method: 'transfer', amount: 100 }],
  ] as const;

  it('ปฏิเสธ FK ข้าม tenant ทุกเส้นทางหลัก', async () => {
    for (const [label, table, data] of cases()) await expect(insert(table, data), label).rejects.toMatchObject({ code: '23503' });
  });
});

describe('สิทธิ์ support ที่ลูกค้าควบคุมเอง (RLS แยก tenant; Owner ตรวจที่ API ของ A31)', () => {
  it('Owner อ่าน แก้ ปิดและเปิดสิทธิ์ใหม่ผ่าน friday_app โดยไม่ข้าม RLS', async () => {
    await as(U.lead, W.one, async (client) => {
      expect((await client.query('SELECT workspace_id, granted_by FROM support_access_grants')).rows).toEqual([{ workspace_id: W.one, granted_by: U.lead }]);
      const updated = await client.query(`UPDATE support_access_grants SET max_mode = 'write', notify_admins = false WHERE workspace_id = $1 RETURNING max_mode, notify_admins`, [W.one]);
      expect(updated.rows).toEqual([{ max_mode: 'write', notify_admins: false }]);
      expect((await client.query('DELETE FROM support_access_grants WHERE workspace_id = $1 RETURNING id', [W.one])).rowCount).toBe(1);
      expect((await client.query('SELECT id FROM support_access_grants')).rows).toEqual([]);
      const id = await insert('support_access_grants', { workspace_id: W.one, granted_by: U.lead }, client);
      expect((await client.query('SELECT id, max_mode FROM support_access_grants')).rows).toEqual([{ id, max_mode: 'read' }]);
    });
  });

  it('อ่าน แก้ หรือลบ grant ของ Workspace อื่นไม่ได้ แม้เป็นสมาชิกทั้งสองที่', async () => {
    await as(U.lead, W.one, async (client) => {
      expect((await client.query('SELECT id FROM support_access_grants WHERE workspace_id = $1', [W.two])).rows).toEqual([]);
      expect((await client.query(`UPDATE support_access_grants SET max_mode = 'write' WHERE workspace_id = $1 RETURNING id`, [W.two])).rowCount).toBe(0);
      expect((await client.query('DELETE FROM support_access_grants WHERE workspace_id = $1 RETURNING id', [W.two])).rowCount).toBe(0);
    });
    await expect(as(U.lead, W.one, (client) => insert('support_access_grants', { workspace_id: W.two, granted_by: U.lead }, client))).rejects.toMatchObject({ code: '42501' });
    await expect(as(U.lead, W.one, (client) => client.query('UPDATE support_access_grants SET workspace_id = $1 WHERE workspace_id = $2', [W.two, W.one]))).rejects.toMatchObject({ code: '42501' });
  });
});

describe('Review หลัง 0008 (migration 0009)', () => {
  it('ประวัติส่งแจ้งเตือนเห็นเฉพาะของตัวเอง ส่วน Workspace Admin เห็นทั้งหมด', async () => {
    const notification = await insert('notifications', { workspace_id: W.one, recipient_id: U.member, event_type: 'issue.assigned', payload: '{}' });
    const delivery = await insert('notification_deliveries', { workspace_id: W.one, notification_id: notification, channel: 'email', target_ref: 'member@example.com' });
    try {
      await as(U.member, W.one, async (client) => {
        expect((await client.query('SELECT id FROM notification_deliveries')).rows).toEqual([{ id: delivery }]);
      });
      await as(U.admin, W.one, async (client) => {
        expect((await client.query('SELECT id FROM notification_deliveries')).rows.map((row) => row.id).sort()).toEqual([delivery, (await owner.query('SELECT id FROM notification_deliveries WHERE notification_id = $1', [one.notification])).rows[0].id].sort());
      });
    } finally {
      await owner.query('DELETE FROM notifications WHERE id = $1', [notification]);
    }
  });

  it('friday_app เขียนประวัติส่งแจ้งเตือนไม่ได้ (งานเบื้องหลังเท่านั้น)', async () => {
    for (const command of ['UPDATE notification_deliveries SET attempts = attempts', 'DELETE FROM notification_deliveries']) {
      await expect(as(U.lead, W.one, (client) => client.query(command))).rejects.toMatchObject({ code: '42501' });
    }
    await expect(as(U.lead, W.one, (client) => insert('notification_deliveries', { workspace_id: W.one, notification_id: one.notification, channel: 'line', target_ref: 'fake' }, client))).rejects.toMatchObject({ code: '42501' });
  });

  it('สมาชิกและ Admin อ่านสิทธิ์ support ได้ แต่เปิด แก้ หรือลบได้เฉพาะ Owner', async () => {
    for (const user of [U.member, U.admin]) {
      await as(user, W.one, async (client) => {
        expect((await client.query('SELECT id FROM support_access_grants')).rows).toHaveLength(1);
        expect((await client.query(`UPDATE support_access_grants SET max_mode = 'write' RETURNING id`)).rowCount).toBe(0);
        expect((await client.query('DELETE FROM support_access_grants RETURNING id')).rowCount).toBe(0);
      });
      await expect(as(user, W.one, async (client) => {
        await client.query('DELETE FROM support_access_grants WHERE workspace_id = $1', [W.one]);
        return insert('support_access_grants', { workspace_id: W.one, granted_by: user }, client);
      })).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('Owner เปิดสิทธิ์ support ในนามคนอื่นไม่ได้', async () => {
    await expect(as(U.lead, W.one, async (client) => {
      await client.query('DELETE FROM support_access_grants WHERE workspace_id = $1', [W.one]);
      return insert('support_access_grants', { workspace_id: W.one, granted_by: U.admin }, client);
    })).rejects.toMatchObject({ code: '42501' });
  });

  it('โดเมนที่ยังไม่ยืนยันไม่กันคนอื่น แต่ยืนยันแล้วเป็นของ Workspace เดียว', async () => {
    const domain = 'shared-claim.example.com';
    await owner.query('BEGIN');
    try {
      await insert('verified_domains', { workspace_id: W.one, domain, dns_token: 'dns-a' });
      await insert('verified_domains', { workspace_id: W.two, domain: domain.toUpperCase(), dns_token: 'dns-b' });
      // Workspace เดียวกันเพิ่มโดเมนซ้ำไม่ได้
      await expect(insert('verified_domains', { workspace_id: W.one, domain: domain.toUpperCase(), dns_token: 'dns-c' })).rejects.toMatchObject({ code: '23505' });
    } finally {
      await owner.query('ROLLBACK');
    }
    await owner.query('BEGIN');
    try {
      const first = await insert('verified_domains', { workspace_id: W.one, domain, dns_token: 'dns-a' });
      const second = await insert('verified_domains', { workspace_id: W.two, domain, dns_token: 'dns-b' });
      await owner.query('UPDATE verified_domains SET verified_at = now() WHERE id = $1', [second]);
      await expect(owner.query('UPDATE verified_domains SET verified_at = now() WHERE id = $1', [first])).rejects.toMatchObject({ code: '23505' });
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});

describe('ช่อง In-app ของการตั้งค่าแจ้งเตือน (migration 0010)', () => {
  it('ผู้ใช้ปิด In-app ของเหตุการณ์ในแถวของตัวเองได้ แต่ตั้งแทนคนอื่นไม่ได้', async () => {
    await as(U.lead, W.one, async (client) => {
      await insert('user_notification_prefs', { workspace_id: W.one, user_id: U.lead, event_type: 'issue.updated', channel: 'in_app', enabled: false }, client);
      expect((await client.query(`SELECT channel, enabled FROM user_notification_prefs WHERE event_type = 'issue.updated'`)).rows).toEqual([{ channel: 'in_app', enabled: false }]);
    });
    await expect(
      as(U.lead, W.one, (client) => insert('user_notification_prefs', { workspace_id: W.one, user_id: U.member, event_type: 'issue.updated', channel: 'in_app', enabled: false }, client)),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('ประวัติส่งออกนอกแอปไม่มีช่อง In-app', async () => {
    await expect(insert('notification_deliveries', { workspace_id: W.one, notification_id: one.notification, channel: 'in_app', target_ref: 'inbox' })).rejects.toMatchObject({ code: '23514' });
  });
});

describe('ข้อมูลระบบและหลังบ้าน Friday', () => {
  it.each(['plans', 'legal_documents'])('%s อ่านได้แม้ยังไม่มี Workspace แต่แก้ไขไม่ได้', async (table) => {
    await as(U.lead, null, async (client) => expect((await client.query(`SELECT id FROM ${table}`)).rows.length).toBeGreaterThan(0));
    for (const command of [`UPDATE ${table} SET id = id`, `DELETE FROM ${table}`, `INSERT INTO ${table} DEFAULT VALUES`]) {
      await expect(as(U.lead, W.one, (client) => client.query(command))).rejects.toMatchObject({ code: '42501' });
    }
  });

  it.each(['staff_users', 'support_sessions', 'feature_flags', 'feature_flag_overrides', 'announcements'])('%s ห้ามลูกค้าอ่านและเขียน', async (table) => {
    for (const command of [`SELECT * FROM ${table}`, `UPDATE ${table} SET id = id`, `DELETE FROM ${table}`, `INSERT INTO ${table} DEFAULT VALUES`]) {
      await expect(as(U.lead, W.one, (client) => client.query(command))).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('friday_system ใช้ตารางใหม่ได้โดยไม่ถูก RLS ปิดกั้น', async () => {
    await owner.query('BEGIN');
    try {
      await owner.query('SET LOCAL ROLE friday_system');
      expect((await owner.query('SELECT id FROM staff_users')).rows).toHaveLength(1);
      expect((await owner.query('SELECT id FROM invoices')).rows).toHaveLength(2);
      await insert('feature_flags', { key: 'system-can-write' });
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
