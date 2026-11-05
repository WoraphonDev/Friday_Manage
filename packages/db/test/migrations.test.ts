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
      expect(Number((await client.query(`SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'public'`)).rows[0].n)).toBe(106);
      await expectPlanSeed(client);
      const before = (await client.query('SELECT * FROM plans ORDER BY code')).rows;
      await migrate(db, { migrationsFolder: folder });
      expect((await client.query('SELECT * FROM plans ORDER BY code')).rows).toEqual(before);
    });
  });

  it('อัปเกรดฐาน 0004 ที่มีข้อมูลผู้ใช้ / งาน / คอมเมนต์ / แจ้งเตือน โดยข้อมูลเดิมไม่เปลี่ยน', async () => {
    const oldFolder = mkdtempSync(join(tmpdir(), 'friday-old-migrations-'));
    try {
      mkdirSync(join(oldFolder, 'meta'));
      const entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 4);
      writeFileSync(join(oldFolder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
      for (const entry of entries) cpSync(join(folder, `${entry.tag}.sql`), join(oldFolder, `${entry.tag}.sql`));
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
        for (const [i, table] of tables.entries()) expect((await client.query(`SELECT * FROM ${table} ORDER BY id`)).rows, table).toEqual(before[i]);
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
});
