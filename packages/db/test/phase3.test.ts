// O30 (ถังขยะ / กู้คืน) และ O32 (Changelog, NPS, Onboarding, ศูนย์ช่วยเหลือ, ผูก Ticket กับงาน) · ทดสอบกับ PostgreSQL จริงด้วย role ที่ถูกบังคับ RLS
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ownerUrl = process.env.DATABASE_OWNER_URL ?? 'postgres://friday_owner:friday_owner_dev@localhost:54329/friday';
const appRole = 'friday_p3_app';
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
const U = { lead: randomUUID(), member: randomUUID(), outsider: randomUUID() };
const W = { one: randomUUID(), two: randomUUID() };

// table / column เป็นค่าคงที่จาก fixture เท่านั้น ส่วนข้อมูลใช้ parameters เสมอ
async function insert(table: string, data: Record<string, unknown>, client: pg.Client = owner, returning = 'id'): Promise<string> {
  const keys = Object.keys(data);
  const { rows } = await client.query(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})${returning ? ` RETURNING ${returning}` : ''}`,
    Object.values(data),
  );
  return rows[0]?.[returning];
}

/** ทำในนามผู้ใช้ผ่าน friday_app แล้ว ROLLBACK · commit = true ใช้กับฟังก์ชันนับยอดที่ต้องตรวจผลด้วย owner */
async function as<T>(user: string | null, ws: string | null, fn: (client: pg.Client) => Promise<T>, commit = false): Promise<T> {
  await app.query('BEGIN');
  let ok = false;
  try {
    await app.query(`SELECT set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)`, [user ?? '', ws ?? '']);
    const result = await fn(app);
    ok = true;
    return result;
  } finally {
    await app.query(commit && ok ? 'COMMIT' : 'ROLLBACK');
  }
}

/** คำสั่งที่ต้องล้มเหลวภายในธุรกรรมเดียวกัน · ใช้ SAVEPOINT เพื่อให้คำสั่งถัดไปยังทำงานต่อได้ */
async function failure(c: pg.Client, run: () => Promise<unknown>): Promise<string> {
  await c.query('SAVEPOINT attempt');
  try {
    await run();
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT attempt');
    return (e as Error).message;
  }
  await c.query('RELEASE SAVEPOINT attempt');
  return 'ไม่มี error';
}

const rows = async (client: pg.Client, sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;

let project: { one: string; two: string };
let issue: string;
let file: string;
let staff: string;
let ticket: { one: string; two: string };
let category: string;
let article: { published: string; draft: string; signedIn: string };
let entry: { published: string; draft: string; future: string; hidden: string };

async function seedProject(ws: string, key: string, lead: string) {
  const id = await insert('projects', { workspace_id: ws, key, name: `โปรเจกต์ ${key}`, start_date: '2026-11-02', golive_date: '2027-03-31', owner_user_id: lead });
  const workflow = await insert('workflows', { workspace_id: ws, project_id: id, name: 'มาตรฐาน' });
  const status = await insert('workflow_statuses', { workspace_id: ws, project_id: id, workflow_id: workflow, name: 'To do', category: 'todo' });
  const type = await insert('issue_types', { workspace_id: ws, project_id: id, workflow_id: workflow, name: 'Task' });
  return { id, status, type };
}

beforeAll(async () => {
  await owner.connect();
  await owner.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${appRole}') THEN
    CREATE ROLE ${appRole} LOGIN PASSWORD '${appRole}' IN ROLE friday_app; END IF; END $$`);
  const tables = (await owner.query(`SELECT string_agg(format('public.%I', tablename), ', ') AS t FROM pg_tables WHERE schemaname = 'public'`)).rows[0].t;
  await owner.query(`TRUNCATE ${tables} CASCADE`);
  for (const [name, id] of Object.entries(U)) await insert('users', { id, email: `${name}@p3.example.com`, display_name: name });
  await insert('workspaces', { id: W.one, slug: 'p3-one', name: 'ทดสอบหนึ่ง' });
  await insert('workspaces', { id: W.two, slug: 'p3-two', name: 'ทดสอบสอง' });
  await owner.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $3, 'owner'), ($1, $4, 'member'), ($2, $5, 'owner')`, [W.one, W.two, U.lead, U.member, U.outsider]);
  const p1 = await seedProject(W.one, 'DP', U.lead);
  const p2 = await seedProject(W.two, 'DP', U.outsider);
  project = { one: p1.id, two: p2.id };
  issue = await insert('issues', { workspace_id: W.one, project_id: p1.id, number: 1, issue_type_id: p1.type, status_id: p1.status, title: 'งานที่จะลบ' });
  file = await insert('files', { workspace_id: W.one, project_id: p1.id, name: 'แบบร่าง.pdf', uploaded_by: U.lead });
  staff = await insert('staff_users', { email: 'support@p3.example.com', name: 'Support', roles: ['support'] });
  ticket = {
    one: await insert('support_tickets', { workspace_id: W.one, requester_user_id: U.lead, subject: 'ทดสอบ' }),
    two: await insert('support_tickets', { workspace_id: W.two, requester_user_id: U.outsider, subject: 'ทดสอบ' }),
  };
  category = (await rows(owner, `SELECT id FROM help_categories WHERE slug = 'projects-issues'`))[0]?.id
    ?? await insert('help_categories', { slug: 'projects-issues', name: 'โปรเจกต์และงาน' });
  const published = { category_id: category, status: 'published', version: 1, published_at: new Date(), pii_checked_at: new Date() };
  article = {
    published: await insert('help_articles', { ...published, slug: 'restore-deleted', title: 'กู้คืนงานที่ลบผิด', body: 'งานในถังขยะกู้คืนได้ 30 วัน', keywords: 'trash, เอากลับ', draft: { body: 'ร่างใหม่ที่ยังไม่เผยแพร่' } }),
    draft: await insert('help_articles', { slug: 'draft-only', category_id: category, title: 'บทความร่าง' }),
    signedIn: await insert('help_articles', { ...published, slug: 'internal-steps', title: 'ขั้นตอนเฉพาะผู้ใช้', visibility: 'signed_in' }),
  };
  const base = { kind: 'new', summary: 'สรุปสั้น' };
  entry = {
    published: await insert('changelog_entries', { ...base, title: 'เผยแพร่แล้ว', status: 'published', published_at: new Date(Date.now() - 86400_000) }),
    draft: await insert('changelog_entries', { ...base, title: 'ร่าง' }),
    future: await insert('changelog_entries', { ...base, title: 'ตั้งเวลา', status: 'scheduled', published_at: new Date(Date.now() + 86400_000) }),
    hidden: await insert('changelog_entries', { ...base, title: 'ซ่อน', status: 'hidden', hidden_at: new Date(), hide_reason: 'เลื่อนเปิดฟีเจอร์' }),
  };
  await app.connect();
  await sys.connect();
});

afterAll(async () => {
  await app.end();
  await sys.end();
  await owner.end();
});

describe('O30 · ถังขยะและการกู้คืน', () => {
  it('ลบผ่านแอปบันทึกผู้ลบจาก app.user_id · กู้คืนแล้วล้างค่า', async () => {
    await as(U.lead, W.one, async (c) => {
      const [deleted] = await rows(c, `UPDATE issues SET deleted_at = now() WHERE id = $1 RETURNING deleted_by`, [issue]);
      expect(deleted.deleted_by).toBe(U.lead);
      const [restored] = await rows(c, `UPDATE issues SET deleted_at = NULL WHERE id = $1 RETURNING deleted_by`, [issue]);
      expect(restored.deleted_by).toBeNull();
      // API ส่งผู้ลบมาเองได้ (เช่น ลบแทน) และ trigger ไม่ทับ
      const [explicit] = await rows(c, `UPDATE files SET deleted_at = now(), deleted_by = $2 WHERE id = $1 RETURNING deleted_by`, [file, U.member]);
      expect(explicit.deleted_by).toBe(U.member);
    });
  });

  it('งานในถังขยะยังเห็นได้เฉพาะผู้มีสิทธิ์ตามเดิม', async () => {
    await owner.query(`UPDATE issues SET deleted_at = now() WHERE id = $1`, [issue]);
    try {
      expect(await as(U.lead, W.one, (c) => rows(c, `SELECT id FROM issues WHERE deleted_at IS NOT NULL`))).toHaveLength(1);
      // สมาชิกที่ไม่ได้อยู่ในโปรเจกต์ private และคนนอก Workspace ไม่เห็น
      expect(await as(U.member, W.one, (c) => rows(c, `SELECT id FROM issues WHERE deleted_at IS NOT NULL`))).toHaveLength(0);
      expect(await as(U.outsider, W.one, (c) => rows(c, `SELECT id FROM issues`))).toHaveLength(0);
    } finally {
      await owner.query(`UPDATE issues SET deleted_at = NULL WHERE id = $1`, [issue]);
    }
  });

  it('ลบ Workspace ตั้งวันลบถาวร +30 วัน · ยืดเวลาได้ · กู้คืนแล้วล้างค่า', async () => {
    const ws = await insert('workspaces', { slug: 'p3-delete', name: 'ลบทดสอบ' });
    await sys.query(`SELECT set_config('app.user_id', $1, false)`, [U.lead]);
    try {
      const [row] = await rows(sys, `UPDATE workspaces SET deleted_at = '2026-11-03T03:00:00Z', status = 'pending_delete' WHERE id = $1 RETURNING deleted_by, purge_after`, [ws]);
      expect(row.deleted_by).toBe(U.lead);
      expect(row.purge_after.toISOString()).toBe('2026-12-03T03:00:00.000Z');
      const [extended] = await rows(sys, `UPDATE workspaces SET purge_after = purge_after + interval '14 days', purge_reminded_at = now() WHERE id = $1 RETURNING purge_after`, [ws]);
      expect(extended.purge_after.toISOString()).toBe('2026-12-17T03:00:00.000Z');
      const [restored] = await rows(sys, `UPDATE workspaces SET deleted_at = NULL, status = 'active' WHERE id = $1 RETURNING deleted_by, purge_after, purge_reminded_at`, [ws]);
      expect(restored).toEqual({ deleted_by: null, purge_after: null, purge_reminded_at: null });
      await expect(sys.query(`UPDATE workspaces SET purge_after = now() WHERE id = $1`, [ws])).rejects.toThrow(/workspaces_purge_after_deleted/);
    } finally {
      await sys.query(`SELECT set_config('app.user_id', '', false)`);
    }
  });

  it('Key ของโปรเจกต์ในถังขยะให้โปรเจกต์ใหม่ใช้ได้ · โปรเจกต์ที่ใช้งานอยู่ Key ซ้ำไม่ได้', async () => {
    const old = await insert('projects', { workspace_id: W.one, key: 'MKT', name: 'Marketing Site 2026', start_date: '2026-11-02', golive_date: '2027-03-31', owner_user_id: U.lead });
    await expect(insert('projects', { workspace_id: W.one, key: 'MKT', name: 'ซ้ำ', start_date: '2026-11-02', golive_date: '2027-03-31', owner_user_id: U.lead }))
      .rejects.toThrow(/projects_workspace_key_key/);
    await owner.query(`UPDATE projects SET deleted_at = now() WHERE id = $1`, [old]);
    await insert('projects', { workspace_id: W.one, key: 'MKT', name: 'Marketing 2027', start_date: '2026-11-02', golive_date: '2027-03-31', owner_user_id: U.lead });
    // กู้คืนโดยไม่เปลี่ยน Key ชนกับโปรเจกต์ใหม่ (A41 ตอบ 409 project_key_taken แล้วให้เลือก Key ใหม่)
    await expect(owner.query(`UPDATE projects SET deleted_at = NULL WHERE id = $1`, [old])).rejects.toThrow(/projects_workspace_key_key/);
    await owner.query(`UPDATE projects SET deleted_at = NULL, key = 'MKS' WHERE id = $1`, [old]);
  });

  it('มีดัชนีบางส่วนของถังขยะ', async () => {
    const found = await rows(owner, `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('issues_trash_idx', 'projects_trash_idx', 'files_trash_idx', 'workspaces_purge_idx') ORDER BY indexname`);
    expect(found.map((r) => r.indexname)).toEqual(['files_trash_idx', 'issues_trash_idx', 'projects_trash_idx', 'workspaces_purge_idx']);
    for (const r of found) expect(r.indexdef).toContain('WHERE (deleted_at IS NOT NULL)');
  });
});

describe('O32 · Changelog และ NPS', () => {
  it('ลูกค้าเห็นเฉพาะรายการที่เผยแพร่และถึงเวลาแล้ว · เขียนไม่ได้', async () => {
    await as(U.member, W.one, async (c) => {
      expect((await rows(c, `SELECT title FROM changelog_entries`)).map((r) => r.title)).toEqual(['เผยแพร่แล้ว']);
      expect(await failure(c, () => c.query(`UPDATE changelog_entries SET title = 'แก้'`))).toMatch(/permission denied/);
    });
    // หน้าสาธารณะ (ไม่ได้เข้าสู่ระบบ) ก็เห็นรายการเดียวกัน
    expect(await as(null, null, (c) => rows(c, `SELECT id FROM changelog_entries`))).toEqual([{ id: entry.published }]);
  });

  it('ยอดเห็น / คลิกเพิ่มได้ผ่านฟังก์ชันเฉพาะรายการที่เผยแพร่ · อ่านตารางตรงไม่ได้', async () => {
    await as(U.member, W.one, async (c) => {
      await c.query(`SELECT app.count_changelog_views($1)`, [[entry.published, entry.draft, entry.future]]);
      await c.query(`SELECT app.count_changelog_click($1)`, [entry.published]);
      await c.query(`SELECT app.count_changelog_click($1)`, [entry.hidden]);
      expect(await failure(c, () => c.query(`SELECT * FROM changelog_stats`))).toMatch(/permission denied/);
    }, true);
    // ไม่ได้เข้าสู่ระบบ (หน้าสาธารณะ) ไม่นับ
    await as(null, null, (c) => c.query(`SELECT app.count_changelog_views($1)`, [[entry.published]]), true);
    expect(await rows(owner, `SELECT entry_id, views, clicks FROM changelog_stats`)).toEqual([{ entry_id: entry.published, views: 1, clicks: 1 }]);
  });

  it('Spotlight มีได้ทีละ 1 รายการ', async () => {
    await owner.query(`UPDATE changelog_entries SET spotlight = true WHERE id = $1`, [entry.published]);
    await expect(owner.query(`UPDATE changelog_entries SET spotlight = true WHERE id = $1`, [entry.future])).rejects.toThrow(/changelog_entries_spotlight_key/);
    await owner.query(`UPDATE changelog_entries SET spotlight = true WHERE id = $1`, [entry.draft]);
  });

  it('กลุ่มผู้เห็นต้องมีค่าที่ตรงกัน และสรุปไม่เกิน 140 ตัว', async () => {
    await expect(insert('changelog_entries', { kind: 'new', title: 'ก', summary: 'ข', audience: 'plans' })).rejects.toThrow(/changelog_entries_audience_values/);
    await expect(insert('changelog_entries', { kind: 'new', title: 'ก', summary: 'ข'.repeat(141) })).rejects.toThrow(/changelog_entries_summary_length/);
    await insert('changelog_entries', { kind: 'improved', title: 'ก', summary: 'ข', audience: 'flag', audience_flag: 'reports.owner_dashboard' });
  });

  it('ตั้งค่า NPS มีแถวเริ่มต้นตามคำตัดสิน ลูกค้าอ่านได้แต่แก้ไม่ได้', async () => {
    await owner.query(`INSERT INTO nps_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);
    await as(U.member, W.one, async (c) => {
      expect(await rows(c, `SELECT audience, first_after_days, repeat_days, sample_pct FROM nps_settings`))
        .toEqual([{ audience: 'admins', first_after_days: 30, repeat_days: 90, sample_pct: 50 }]);
      expect(await failure(c, () => c.query(`UPDATE nps_settings SET sample_pct = 100`))).toMatch(/permission denied/);
    });
    await expect(owner.query(`INSERT INTO nps_settings (id) VALUES (2)`)).rejects.toThrow(/nps_settings_singleton/);
  });

  it('คำตอบ NPS: เพิ่มและอ่านได้เฉพาะของตัวเอง · ไม่เห็นของ Workspace อื่น · ไม่เห็นบันทึกภายใน', async () => {
    await insert('nps_responses', { workspace_id: W.two, user_id: U.outsider, role: 'owner', score: 3, comment: 'ช้า', note: 'ภายใน' });
    await insert('nps_responses', { workspace_id: W.one, user_id: U.member, role: 'member', score: 9 });
    await as(U.lead, W.one, async (c) => {
      await insert('nps_responses', { workspace_id: W.one, user_id: U.lead, role: 'owner', plan: 'team_s', score: 7, comment: 'ดี', topics: ['price'] }, c);
      await insert('nps_responses', { workspace_id: W.one, user_id: U.lead, role: 'owner' }, c);
      // Owner ก็ไม่เห็นคำตอบของสมาชิก
      expect((await rows(c, `SELECT user_id, score FROM nps_responses ORDER BY score NULLS LAST`)).map((r) => [r.user_id, r.score])).toEqual([[U.lead, 7], [U.lead, null]]);
      expect(await failure(c, () => c.query(`SELECT note FROM nps_responses`))).toMatch(/permission denied/);
      expect(await failure(c, () => c.query(`UPDATE nps_responses SET score = 10`))).toMatch(/permission denied/);
      expect(await failure(c, () => insert('nps_responses', { workspace_id: W.two, user_id: U.lead, role: 'owner', score: 10 }, c))).toMatch(/row-level security/);
      expect(await failure(c, () => insert('nps_responses', { workspace_id: W.one, user_id: U.member, role: 'member', score: 10 }, c))).toMatch(/row-level security/);
    });
    await expect(insert('nps_responses', { workspace_id: W.one, user_id: U.lead, role: 'owner', comment: 'ไม่มีคะแนน' })).rejects.toThrow(/nps_responses_dismissed/);
    await expect(insert('nps_responses', { workspace_id: W.one, user_id: U.lead, role: 'owner', score: 11 })).rejects.toThrow(/nps_responses_score_range/);
    // Ticket ติดตามต้องอยู่ Workspace เดียวกับคำตอบ
    await expect(insert('nps_responses', { workspace_id: W.one, role: 'owner', score: 2, ticket_id: ticket.two })).rejects.toThrow(/nps_responses_ticket_fk/);
    await insert('nps_responses', { workspace_id: W.one, role: 'owner', score: 2, ticket_id: ticket.one, follow_up_status: 'done' });
  });

  it('ลบบัญชีแล้วคำตอบยังอยู่โดย user_id เป็น null', async () => {
    const gone = await insert('users', { email: 'gone@p3.example.com', display_name: 'ลาออก' });
    const id = await insert('nps_responses', { workspace_id: W.one, user_id: gone, role: 'member', score: 8 });
    await owner.query(`DELETE FROM users WHERE id = $1`, [gone]);
    expect(await rows(owner, `SELECT user_id, score FROM nps_responses WHERE id = $1`, [id])).toEqual([{ user_id: null, score: 8 }]);
  });

  it('สถานะ UI แก้ได้เฉพาะของตัวเอง', async () => {
    await as(U.member, W.one, async (c) => {
      await c.query(`INSERT INTO user_ui_states (user_id, whats_new_seen_at) VALUES ($1, now())`, [U.member]);
      expect(await failure(c, () => c.query(`INSERT INTO user_ui_states (user_id) VALUES ($1)`, [U.lead]))).toMatch(/row-level security/);
      expect(await rows(c, `SELECT user_id FROM user_ui_states`)).toEqual([{ user_id: U.member }]);
    });
  });
});

describe('O32 · Onboarding', () => {
  it('ขั้นของ Workspace ทุกคนใน Workspace เห็น · ขั้นส่วนตัวเห็นเฉพาะเจ้าของ · บันทึกซ้ำไม่ได้', async () => {
    await insert('onboarding_progress', { workspace_id: W.two, step: 'first_project' });
    await insert('onboarding_progress', { workspace_id: W.one, user_id: U.lead, step: 'profile' });
    await as(U.member, W.one, async (c) => {
      await insert('onboarding_progress', { workspace_id: W.one, step: 'tasks_10', meta: { count: 12 } }, c);
      await insert('onboarding_progress', { workspace_id: W.one, user_id: U.member, step: 'open_assigned' }, c);
      expect(await failure(c, () => insert('onboarding_progress', { workspace_id: W.one, step: 'tasks_10' }, c))).toMatch(/onboarding_progress_step_key/);
      expect(await failure(c, () => insert('onboarding_progress', { workspace_id: W.one, user_id: U.lead, step: 'profile' }, c))).toMatch(/row-level security/);
      expect(await failure(c, () => insert('onboarding_progress', { workspace_id: W.two, step: 'tasks_10' }, c))).toMatch(/row-level security/);
      expect(await failure(c, () => c.query(`UPDATE onboarding_progress SET step = 'x'`))).toMatch(/permission denied/);
      // ไม่เห็นขั้นส่วนตัวของคนอื่นและขั้นของ Workspace อื่น
      expect((await rows(c, `SELECT step FROM onboarding_progress ORDER BY step`)).map((r) => r.step)).toEqual(['open_assigned', 'tasks_10']);
    });
  });

  it('ซ่อนการ์ดได้เฉพาะของตัวเอง · ติดตามลูกค้าเป็นของทีม Friday', async () => {
    await as(U.member, W.one, async (c) => {
      await insert('onboarding_dismissals', { workspace_id: W.one, user_id: U.member, hidden_at: new Date() }, c, '');
      await c.query(`UPDATE onboarding_dismissals SET never = true`);
      expect(await failure(c, () => insert('onboarding_dismissals', { workspace_id: W.one, user_id: U.lead, hidden_at: new Date() }, c, ''))).toMatch(/row-level security/);
      expect(await failure(c, () => c.query(`SELECT * FROM onboarding_followups`))).toMatch(/permission denied/);
    });
    await insert('onboarding_followups', { workspace_id: W.one, assignee_id: staff, status: 'emailed', last_emailed_at: new Date(), emails_sent: 1 }, sys, 'workspace_id');
  });
});

describe('O32 · ศูนย์ช่วยเหลือ', () => {
  it('ลูกค้าอ่านบทความร่างไม่ได้ · บทความเฉพาะผู้เข้าสู่ระบบต้องมีผู้ใช้', async () => {
    const signedIn = await as(U.member, W.one, (c) => rows(c, `SELECT slug FROM help_articles ORDER BY slug`));
    expect(signedIn.map((r) => r.slug)).toEqual(['internal-steps', 'restore-deleted']);
    const anonymous = await as(null, null, (c) => rows(c, `SELECT slug FROM help_articles`));
    expect(anonymous.map((r) => r.slug)).toEqual(['restore-deleted']);
  });

  it('ร่างของบทความที่เผยแพร่และข้อมูลภายในไม่หลุดถึงลูกค้า', async () => {
    await as(U.member, W.one, async (c) => {
      for (const sql of [`SELECT draft FROM help_articles`, `SELECT * FROM help_articles`, `SELECT * FROM help_article_versions`, `UPDATE help_articles SET title = 'แก้'`]) {
        expect(await failure(c, () => c.query(sql)), sql).toMatch(/permission denied/);
      }
    });
  });

  it('ค้นด้วยข้อความภาษาไทยและคำค้นเพิ่มผ่าน search_text', async () => {
    const found = await as(null, null, (c) => rows(c, `SELECT slug FROM help_articles WHERE search_text ILIKE $1`, ['%เอากลับ%']));
    expect(found).toEqual([{ slug: 'restore-deleted' }]);
  });

  it('เผยแพร่ต้องติ๊กตรวจข้อมูลลูกค้าก่อน', async () => {
    await expect(insert('help_articles', { slug: 'no-check', category_id: category, title: 'ไม่ตรวจ', status: 'published', version: 1, published_at: new Date() }))
      .rejects.toThrow(/help_articles_published/);
  });

  it('โหวตเพิ่มได้เฉพาะบทความที่เห็น และอ่านโหวตไม่ได้', async () => {
    await as(null, null, async (c) => {
      await insert('help_feedback', { article_id: article.published, helpful: false, comment: 'ไฟล์มีหลายชีต' }, c, '');
      expect(await failure(c, () => insert('help_feedback', { article_id: article.draft, helpful: true }, c, ''))).toMatch(/row-level security/);
      expect(await failure(c, () => insert('help_feedback', { article_id: article.signedIn, helpful: true }, c, ''))).toMatch(/row-level security/);
      expect(await failure(c, () => c.query(`SELECT * FROM help_feedback`))).toMatch(/permission denied/);
    });
  });

  it('ยอดอ่านและคำค้นที่ไม่พบเพิ่มผ่านฟังก์ชัน · ตัดอีเมลและเบอร์โทรก่อนเก็บ', async () => {
    await as(null, null, async (c) => {
      await c.query(`SELECT app.record_help_view($1)`, [article.published]);
      await c.query(`SELECT app.record_help_view($1)`, [article.draft]);
      await c.query(`SELECT app.record_help_view($1)`, [article.signedIn]);
      await c.query(`SELECT app.record_help_search($1, true)`, ['ขอเลื่อน Due']);
      await c.query(`SELECT app.record_help_search($1, false)`, ['ลบ  Sprint']);
      await c.query(`SELECT app.record_help_search($1, false)`, ['ลบ sprint ติดต่อ somchai@example.com 081-234-5678']);
      expect(await failure(c, () => c.query(`SELECT * FROM help_search_misses`))).toMatch(/permission denied/);
      expect(await rows(c, `SELECT article_id, views FROM help_article_views`)).toEqual([{ article_id: article.published, views: 1 }]);
    }, true);
    expect(await rows(owner, `SELECT searches, misses FROM help_search_stats`)).toEqual([{ searches: 3, misses: 2 }]);
    expect(await rows(owner, `SELECT query, searches FROM help_search_misses ORDER BY query`)).toEqual([
      { query: 'ลบ sprint', searches: 1 },
      { query: 'ลบ sprint ติดต่อ', searches: 1 },
    ]);
  });

  it('หมวดที่มีบทความลบไม่ได้', async () => {
    await expect(owner.query(`DELETE FROM help_categories WHERE id = $1`, [category])).rejects.toThrow(/help_articles_category_id_help_categories_id_fk/);
  });
});

describe('O32 · ผูก Ticket กับงานของทีมพัฒนา', () => {
  it('1 Ticket ผูกได้ 1 งาน · หลาย Ticket ผูกงานเดียวกันได้ · แจ้งลูกค้าแล้วต้องมีเวลา', async () => {
    const link = await insert('dev_issue_links', { issue_key: 'FM-482', title: 'Sub-task หายเมื่อ Parent Key ว่าง', severity: 'S2', status_category: 'done', released_at: new Date() }, sys);
    await insert('dev_issue_tickets', { ticket_id: ticket.one, link_id: link, linked_by: staff }, sys, 'ticket_id');
    await insert('dev_issue_tickets', { ticket_id: ticket.two, link_id: link }, sys, 'ticket_id');
    await expect(insert('dev_issue_tickets', { ticket_id: ticket.one, link_id: link }, sys, 'ticket_id')).rejects.toThrow(/dev_issue_tickets_pkey/);
    await expect(sys.query(`UPDATE dev_issue_tickets SET outcome = 'fixed' WHERE ticket_id = $1`, [ticket.one])).rejects.toThrow(/dev_issue_tickets_notified/);
    await sys.query(`UPDATE dev_issue_tickets SET outcome = 'fixed', notified_at = now() WHERE ticket_id = $1`, [ticket.one]);
    await expect(insert('dev_issue_links', { issue_key: 'FM-490', title: 'ซ้ำ', severity: 'S5' }, sys)).rejects.toThrow(/dev_issue_links_severity_valid/);
  });

  it('การตั้งค่าเชื่อมต่อมีแถวเดียว', async () => {
    await insert('dev_bridge_settings', { id: 1, workspace_slug: 'friday-dev', project_key: 'FM' }, sys);
    await expect(insert('dev_bridge_settings', { id: 2 }, sys)).rejects.toThrow(/dev_bridge_settings_singleton/);
  });
});
