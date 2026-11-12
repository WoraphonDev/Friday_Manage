// ใช้ฐานชั่วคราวแยกจากฐาน test หลัก เพื่อยืนยันทั้งการติดตั้งใหม่และอัปเกรดจาก 0004
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ownerUrl = process.env.DATABASE_OWNER_URL ?? 'postgres://friday_owner:friday_owner_dev@localhost:54329/friday';
const admin = new pg.Client({ connectionString: ownerUrl });
const folder = fileURLToPath(new URL('../migrations', import.meta.url));
const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8'));

beforeAll(() => admin.connect());
afterAll(() => admin.end());

function migrationsThrough(index: number) {
  const directory = mkdtempSync(join(tmpdir(), 'friday-old-migrations-'));
  mkdirSync(join(directory, 'meta'));
  const entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= index);
  writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) cpSync(join(folder, `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
  return directory;
}

async function withDatabase(fn: (client: pg.Client) => Promise<void>) {
  const name = `friday_migration_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(ownerUrl);
  url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const client = new pg.Client({ connectionString: url.toString() });
  try {
    await client.connect();
    await fn(client);
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  }
}

async function expectPlanSeed(client: pg.Client) {
  const { rows } = await client.query(`SELECT code, seat_limit, price_monthly_satang, price_yearly_satang FROM plans ORDER BY code`);
  expect(rows).toEqual([
    { code: 'enterprise', seat_limit: null, price_monthly_satang: null, price_yearly_satang: null },
    { code: 'free', seat_limit: 5, price_monthly_satang: null, price_yearly_satang: null },
    { code: 'team_l', seat_limit: 50, price_monthly_satang: null, price_yearly_satang: null },
    { code: 'team_m', seat_limit: 25, price_monthly_satang: null, price_yearly_satang: null },
    { code: 'team_s', seat_limit: 10, price_monthly_satang: null, price_yearly_satang: null },
  ]);
  const teamFeatures = (await client.query(`SELECT DISTINCT features FROM plans WHERE code LIKE 'team_%'`)).rows;
  expect(teamFeatures).toHaveLength(1);
}

describe('Migration T00', () => {
  it('migrate ฐานว่างได้ครบ มี seed และรันซ้ำไม่เปลี่ยนข้อมูล', async () => {
    await withDatabase(async (client) => {
      const db = drizzle(client);
      await migrate(db, { migrationsFolder: folder });
      expect(Number((await client.query(`SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'public'`)).rows[0].n)).toBe(166);
      await expectPlanSeed(client);
      const before = (await client.query('SELECT * FROM plans ORDER BY code')).rows;
      await migrate(db, { migrationsFolder: folder });
      expect((await client.query('SELECT * FROM plans ORDER BY code')).rows).toEqual(before);
    });
  });

  it('อัปเกรดฐาน 0004 ที่มีข้อมูลผู้ใช้ / งาน / คอมเมนต์ / แจ้งเตือน โดยข้อมูลเดิมไม่เปลี่ยน', async () => {
    const oldFolder = migrationsThrough(4);
    try {
      await withDatabase(async (client) => {
        const db = drizzle(client);
        await migrate(db, { migrationsFolder: oldFolder });
        const user = (await client.query(`INSERT INTO users (email, display_name) VALUES ('migration@example.com', 'ทดสอบ') RETURNING id`)).rows[0].id;
        const ws = (await client.query(`INSERT INTO workspaces (slug, name) VALUES ('migration-test', 'ทดสอบ') RETURNING id`)).rows[0].id;
        const project = (await client.query(`INSERT INTO projects (workspace_id, key, name, start_date, golive_date, owner_user_id)
          VALUES ($1, 'MT', 'ทดสอบ', '2026-11-05', '2027-04-21', $2) RETURNING id`, [ws, user])).rows[0].id;
        const workflow = (await client.query(`INSERT INTO workflows (workspace_id, project_id, name) VALUES ($1, $2, 'ทดสอบ') RETURNING id`, [ws, project])).rows[0].id;
        const status = (await client.query(`INSERT INTO workflow_statuses (workspace_id, project_id, workflow_id, name, category) VALUES ($1, $2, $3, 'To do', 'todo') RETURNING id`, [ws, project, workflow])).rows[0].id;
        const type = (await client.query(`INSERT INTO issue_types (workspace_id, project_id, workflow_id, name) VALUES ($1, $2, $3, 'Task') RETURNING id`, [ws, project, workflow])).rows[0].id;
        const issue = (await client.query(`INSERT INTO issues (workspace_id, project_id, number, issue_type_id, status_id, title, description, estimate_md, plan_start, plan_end)
          VALUES ($1, $2, 1, $3, $4, 'ข้อมูลเดิม', 'ต้องไม่หายหลังอัปเกรด', 3, '2026-11-05', '2026-11-09') RETURNING id`, [ws, project, type, status])).rows[0].id;
        await client.query(`INSERT INTO comments (workspace_id, issue_id, author_id, body) VALUES ($1, $2, $3, 'หลักฐานเดิม')`, [ws, issue, user]);
        await client.query(`INSERT INTO notifications (workspace_id, recipient_id, event_type, payload) VALUES ($1, $2, 'issue.created', '{}')`, [ws, user]);
        const tables = ['users', 'workspaces', 'projects', 'issues', 'comments', 'notifications'];
        const before: pg.QueryResultRow[][] = [];
        for (const table of tables) before.push((await client.query(`SELECT * FROM ${table} ORDER BY id`)).rows);
        await migrate(db, { migrationsFolder: folder });
        // คอลัมน์ที่ migration ถัดไปเพิ่ม (มีค่าเริ่มต้น) ไม่นับเป็นข้อมูลเดิมที่เปลี่ยน · notifications.in_app (0011) ต้องเป็น true
        // issues.sa_id (0013) และ issues.remark (0014) เป็น null สำหรับงานเดิม · projects.field_profile (0015) = {} คือชุดฟิลด์มาตรฐาน
        // deleted_by / purge_after (0032) เป็น null สำหรับแถวที่ไม่ได้อยู่ในถังขยะ
        const added: Record<string, Record<string, unknown>> = { notifications: { in_app: true }, issues: { sa_id: null, remark: null, deleted_by: null }, projects: { field_profile: {}, progress_split: false, deleted_by: null }, workspaces: { suspension_mode: null, suspension_message: null, suspension_auto_resume: false, deleted_by: null, purge_after: null, purge_reminded_at: null } };
        for (const [i, table] of tables.entries()) expect((await client.query(`SELECT * FROM ${table} ORDER BY id`)).rows, table).toEqual(before[i].map((r: Record<string, unknown>) => ({ ...r, ...added[table] })));
        await expectPlanSeed(client);
        // ตรวจด้วยข้อมูลเดิมจริงว่า FK ของตารางใหม่ผูกกับ notification ที่มีอยู่แล้วได้
        await client.query(`INSERT INTO notification_deliveries (workspace_id, notification_id, channel, target_ref)
          SELECT workspace_id, id, 'email', 'migration@example.com' FROM notifications`);
        expect((await client.query('SELECT count(*)::int AS n FROM notification_deliveries')).rows[0].n).toBe(1);
      });
    } finally {
      rmSync(oldFolder, { recursive: true, force: true });
    }
  });

  it('อัปเกรด 0031 → 0032 ตั้งวันลบถาวรและผู้ลบของแถวในถังขยะเดิม โดย updated_at / version ไม่เปลี่ยน', async () => {
    const oldFolder = migrationsThrough(31);
    try {
      await withDatabase(async (client) => {
        const db = drizzle(client);
        await migrate(db, { migrationsFolder: oldFolder });
        const user = (await client.query(`INSERT INTO users (email, display_name) VALUES ('trash@example.com', 'ทดสอบ') RETURNING id`)).rows[0].id;
        const gone = (await client.query(`INSERT INTO workspaces (slug, name, status, deleted_at) VALUES ('trash-gone', 'ลบแล้ว', 'pending_delete', '2026-11-03T03:00:00Z') RETURNING id`)).rows[0].id;
        await client.query(`INSERT INTO audit_logs (workspace_id, actor_id, actor_kind, category, action, target_type, target_id) VALUES ($1, $2, 'user', 'secu', 'workspace.deleted', 'workspace', $1)`, [gone, user]);
        const ws = (await client.query(`INSERT INTO workspaces (slug, name) VALUES ('trash-live', 'ใช้งาน') RETURNING id`)).rows[0].id;
        const project = (await client.query(`INSERT INTO projects (workspace_id, key, name, start_date, golive_date, owner_user_id, deleted_at)
          VALUES ($1, 'TR', 'ถังขยะ', '2026-11-05', '2027-04-21', $2, '2026-11-10T09:00:00Z') RETURNING id`, [ws, user])).rows[0].id;
        await client.query(`INSERT INTO audit_logs (workspace_id, actor_id, actor_kind, category, action, target_type, target_id) VALUES ($1, $2, 'user', 'data', 'project.deleted', 'project', $3)`, [ws, user, project]);
        const workflow = (await client.query(`INSERT INTO workflows (workspace_id, project_id, name) VALUES ($1, $2, 'ทดสอบ') RETURNING id`, [ws, project])).rows[0].id;
        const status = (await client.query(`INSERT INTO workflow_statuses (workspace_id, project_id, workflow_id, name, category) VALUES ($1, $2, $3, 'To do', 'todo') RETURNING id`, [ws, project, workflow])).rows[0].id;
        const type = (await client.query(`INSERT INTO issue_types (workspace_id, project_id, workflow_id, name) VALUES ($1, $2, $3, 'Task') RETURNING id`, [ws, project, workflow])).rows[0].id;
        const issue = (await client.query(`INSERT INTO issues (workspace_id, project_id, number, issue_type_id, status_id, title, deleted_at)
          VALUES ($1, $2, 1, $3, $4, 'งานที่ลบ', '2026-11-11T09:02:00Z') RETURNING id`, [ws, project, type, status])).rows[0].id;
        await client.query(`INSERT INTO activities (workspace_id, project_id, issue_id, actor_id, verb, field) VALUES ($1, $2, $3, $4, 'deleted', 'deletedAt')`, [ws, project, issue, user]);
        const file = (await client.query(`INSERT INTO files (workspace_id, project_id, name, uploaded_by, deleted_at) VALUES ($1, $2, 'แบบร่าง.pdf', $3, now()) RETURNING id`, [ws, project, user])).rows[0].id;
        await client.query(`INSERT INTO audit_logs (workspace_id, actor_id, actor_kind, category, action, target_type, target_id) VALUES ($1, $2, 'user', 'data', 'file.deleted', 'file', $3)`, [ws, user, file]);
        const before = {
          workspaces: (await client.query('SELECT id, updated_at FROM workspaces ORDER BY id')).rows,
          projects: (await client.query('SELECT id, updated_at, version FROM projects')).rows,
          issues: (await client.query('SELECT id, updated_at, version FROM issues')).rows,
        };
        await migrate(db, { migrationsFolder: folder });
        expect((await client.query('SELECT slug, deleted_by, purge_after FROM workspaces ORDER BY slug')).rows).toEqual([
          { slug: 'trash-gone', deleted_by: user, purge_after: new Date('2026-12-03T03:00:00Z') },
          { slug: 'trash-live', deleted_by: null, purge_after: null },
        ]);
        expect((await client.query('SELECT deleted_by FROM projects')).rows).toEqual([{ deleted_by: user }]);
        expect((await client.query('SELECT deleted_by FROM issues')).rows).toEqual([{ deleted_by: user }]);
        expect((await client.query('SELECT deleted_by FROM files')).rows).toEqual([{ deleted_by: user }]);
        expect((await client.query('SELECT id, updated_at FROM workspaces ORDER BY id')).rows).toEqual(before.workspaces);
        expect((await client.query('SELECT id, updated_at, version FROM projects')).rows).toEqual(before.projects);
        expect((await client.query('SELECT id, updated_at, version FROM issues')).rows).toEqual(before.issues);
        // trigger touch กลับมาทำงานหลังย้ายข้อมูล
        await client.query(`UPDATE issues SET title = 'แก้หลังอัปเกรด'`);
        expect((await client.query('SELECT version FROM issues')).rows).toEqual([{ version: before.issues[0].version + 1 }]);
      });
    } finally {
      rmSync(oldFolder, { recursive: true, force: true });
    }
  });

  it('อัปเกรด 0007 ให้ลูกค้าจัดการ support grant เดิมได้ โดยข้อมูลไม่เปลี่ยน', async () => {
    const oldFolder = migrationsThrough(7);
    try {
      await withDatabase(async (client) => {
        const db = drizzle(client);
        await migrate(db, { migrationsFolder: oldFolder });
        const user = (await client.query(`INSERT INTO users (email, display_name) VALUES ('support@example.com', 'ทดสอบ') RETURNING id`)).rows[0].id;
        const ws = (await client.query(`INSERT INTO workspaces (slug, name) VALUES ('support-test', 'ทดสอบ') RETURNING id`)).rows[0].id;
        await client.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [ws, user]);
        await client.query(`INSERT INTO support_access_grants (workspace_id, granted_by) VALUES ($1, $2)`, [ws, user]);
        const before = (await client.query('SELECT * FROM support_access_grants')).rows;
        expect((await client.query(`SELECT has_table_privilege('friday_app', 'support_access_grants', 'SELECT') AS allowed`)).rows[0].allowed).toBe(false);
        await migrate(db, { migrationsFolder: folder });
        expect((await client.query('SELECT * FROM support_access_grants')).rows).toEqual(before);
        await client.query('BEGIN');
        try {
          await client.query('SET LOCAL ROLE friday_app');
          await client.query(`SELECT set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)`, [user, ws]);
          expect((await client.query('SELECT * FROM support_access_grants')).rows).toEqual(before);
          expect((await client.query(`UPDATE support_access_grants SET max_mode = 'write' RETURNING max_mode`)).rows).toEqual([{ max_mode: 'write' }]);
        } finally {
          await client.query('ROLLBACK');
        }
      });
    } finally {
      rmSync(oldFolder, { recursive: true, force: true });
    }
  });
});
