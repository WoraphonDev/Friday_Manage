// ทดสอบ RLS กับ PostgreSQL จริง (docker compose up -d postgres แล้ว pnpm db:migrate ก่อน)
// ตรวจตาม docs/spec/04-permissions.md ข้อ 4–6
import { count as dCount } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withTenant } from '../src/client.ts';
import { issues } from '../src/schema/index.ts';

const OWNER_URL = process.env.DATABASE_OWNER_URL ?? 'postgres://friday_owner:friday_owner_dev@localhost:54329/friday';
const APP_ROLE = 'friday_api_test';
const APP_URL = OWNER_URL.replace(/\/\/[^@]+@/, `//${APP_ROLE}:${APP_ROLE}@`);

const owner = new pg.Client({ connectionString: OWNER_URL });
const app = new pg.Client({ connectionString: APP_URL });

// id คงที่ อ่านผลทดสอบง่าย
const U = {
  mick: '00000000-0000-7000-8000-000000000001', // Owner ws1 · Project Owner P1, P2
  kaijeaw: '00000000-0000-7000-8000-000000000002', // Member ws1 · Member ใน P1
  guest: '00000000-0000-7000-8000-000000000003', // Guest ws1 · ไม่ได้ถูกเชิญเข้าโปรเจกต์ไหน
  outsider: '00000000-0000-7000-8000-000000000004', // Owner ws2 เท่านั้น
  arm: '00000000-0000-7000-8000-000000000005', // Admin ws1 · ไม่ได้เป็นสมาชิก P1
  freelance: '00000000-0000-7000-8000-000000000006', // Guest ws1 · ถูกเชิญเป็น Member ใน P1
};
const WS1 = '00000000-0000-7000-8000-0000000000a1';
const WS2 = '00000000-0000-7000-8000-0000000000a2';
const P1 = '00000000-0000-7000-8000-0000000000b1'; // ws1 · Private
const P2 = '00000000-0000-7000-8000-0000000000b2'; // ws1 · ทั้ง Workspace
const Q1 = '00000000-0000-7000-8000-0000000000b3'; // ws2 · Private

/** รันคำสั่งในฐานะผู้ใช้ (friday_app) ภายในธุรกรรม แล้ว rollback ทุกครั้ง */
async function as<T>(userId: string | null, workspaceId: string | null, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await app.query('BEGIN');
  try {
    await app.query(`SELECT set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)`, [
      userId ?? '',
      workspaceId ?? '',
    ]);
    return await fn(app);
  } finally {
    await app.query('ROLLBACK');
  }
}

const count = async (c: pg.Client, sql: string, params: unknown[] = []) =>
  Number((await c.query(`SELECT count(*)::int AS n FROM (${sql}) x`, params)).rows[0].n);

async function seed() {
  const tables = (
    await owner.query(`SELECT string_agg(format('public.%I', tablename), ', ') AS t FROM pg_tables WHERE schemaname = 'public'`)
  ).rows[0].t;
  await owner.query(`TRUNCATE ${tables} CASCADE`);

  await owner.query(
    `INSERT INTO users (id, email, display_name) VALUES
      ($1, 'mick@example.com', 'Mick'), ($2, 'kaijeaw@example.com', 'Kaijeaw'), ($3, 'client@example.com', 'Client'),
      ($4, 'other@example.com', 'Other'), ($5, 'arm@example.com', 'Arm'), ($6, 'freelance@example.com', 'Freelance')`,
    [U.mick, U.kaijeaw, U.guest, U.outsider, U.arm, U.freelance],
  );
  await owner.query(`INSERT INTO workspaces (id, slug, name) VALUES ($1, 'friday-dev', 'Friday'), ($2, 'acme', 'Acme')`, [WS1, WS2]);
  await owner.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
      ($1, $3, 'owner'), ($1, $4, 'member'), ($1, $5, 'guest'), ($1, $7, 'admin'), ($1, $8, 'guest'), ($2, $6, 'owner')`,
    [WS1, WS2, U.mick, U.kaijeaw, U.guest, U.outsider, U.arm, U.freelance],
  );

  const project = async (id: string, ws: string, key: string, vis: string, ownerId: string) => {
    await owner.query(
      `INSERT INTO projects (id, workspace_id, key, name, start_date, golive_date, owner_user_id, visibility)
       VALUES ($1, $2, $3, $3, '2026-11-05', '2027-04-21', $4, $5)`,
      [id, ws, key, ownerId, vis],
    );
    const wf = (await owner.query(`INSERT INTO workflows (workspace_id, project_id, name) VALUES ($1, $2, 'มาตรฐาน') RETURNING id`, [ws, id])).rows[0].id;
    const st = (
      await owner.query(
        `INSERT INTO workflow_statuses (workspace_id, project_id, workflow_id, name, category) VALUES ($1, $2, $3, 'To do', 'todo') RETURNING id`,
        [ws, id, wf],
      )
    ).rows[0].id;
    const ty = (
      await owner.query(`INSERT INTO issue_types (workspace_id, project_id, name, workflow_id) VALUES ($1, $2, 'Task', $3) RETURNING id`, [ws, id, wf])
    ).rows[0].id;
    return { ws, id, st, ty };
  };
  const issue = async (p: { ws: string; id: string; st: string; ty: string }, n: number, parentId: string | null = null) =>
    (
      await owner.query(
        `INSERT INTO issues (workspace_id, project_id, number, issue_type_id, status_id, title, parent_id)
         VALUES ($1, $2, $3::int, $4, $5, 'งาน ' || $3::text, $6) RETURNING id`,
        [p.ws, p.id, n, p.ty, p.st, parentId],
      )
    ).rows[0].id as string;

  const p1 = await project(P1, WS1, 'DP', 'private', U.mick);
  const p2 = await project(P2, WS1, 'FG', 'workspace', U.mick);
  const q1 = await project(Q1, WS2, 'AC', 'private', U.outsider);
  await owner.query(
    `INSERT INTO project_members (workspace_id, project_id, user_id, role) VALUES
      ($1, $2, $3, 'admin'), ($1, $2, $4, 'member'), ($1, $2, $5, 'member'), ($1, $6, $3, 'admin')`,
    [WS1, P1, U.mick, U.kaijeaw, U.freelance, P2],
  );

  const p1Task = await issue(p1, 39);
  await issue(p1, 526, p1Task);
  await issue(p2, 1);
  await issue(q1, 1);
  await owner.query(`INSERT INTO comments (workspace_id, issue_id, author_id, body) VALUES ($1, $2, $3, 'ลับ')`, [WS1, p1Task, U.mick]);
  await owner.query(
    `INSERT INTO notifications (workspace_id, recipient_id, event_type, payload) VALUES ($1, $2, 'issue.assigned', '{}')`,
    [WS1, U.mick],
  );
  return { p1, p2, q1, p1Task };
}

let fx: Awaited<ReturnType<typeof seed>>;

beforeAll(async () => {
  await owner.connect();
  await owner.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
      CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_ROLE}' IN ROLE friday_app;
    END IF; END $$`);
  fx = await seed();
  await app.connect();
});

afterAll(async () => {
  await app.end();
  await owner.end();
});

describe('โครงสร้าง', () => {
  it('ทุกตารางใน public เปิด RLS และมี policy อย่างน้อย 1 ตัว', async () => {
    const { rows } = await owner.query(`
      SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))`);
    // auth_tokens ใช้เฉพาะ friday_system จึงไม่มี policy (ปิดทั้งหมดสำหรับแอป)
    expect(rows.map((r) => r.relname)).toEqual(['auth_tokens']);
  });

  it('role ของแอปไม่ข้าม RLS', async () => {
    const { rows } = await owner.query(`SELECT rolbypassrls FROM pg_roles WHERE rolname = 'friday_app'`);
    expect(rows[0].rolbypassrls).toBe(false);
  });
});

describe('ชั้นที่ 1: แยก Workspace', () => {
  it('ไม่ตั้งผู้ใช้ / Workspace → ไม่เห็นอะไร', async () => {
    await as(null, null, async (c) => {
      expect(await count(c, 'SELECT * FROM issues')).toBe(0);
      expect(await count(c, 'SELECT * FROM projects')).toBe(0);
      expect(await count(c, 'SELECT * FROM workspaces')).toBe(0);
    });
  });

  it('Mick ใน ws1 เห็นงานของ ws1 เท่านั้น', async () => {
    await as(U.mick, WS1, async (c) => {
      expect(await count(c, 'SELECT * FROM issues')).toBe(3);
      expect(await count(c, 'SELECT * FROM issues WHERE project_id = $1', [Q1])).toBe(0);
    });
  });

  it('ตั้ง Workspace ที่ตัวเองไม่ได้เป็นสมาชิก → ไม่เห็นอะไร', async () => {
    await as(U.mick, WS2, async (c) => {
      expect(await count(c, 'SELECT * FROM issues')).toBe(0);
      expect(await count(c, 'SELECT * FROM projects')).toBe(0);
    });
  });

  it('สมาชิกที่ถูกปิดการใช้งานไม่เห็นอะไร', async () => {
    await owner.query(`UPDATE workspace_members SET status = 'deactivated' WHERE user_id = $1`, [U.kaijeaw]);
    try {
      await as(U.kaijeaw, WS1, async (c) => expect(await count(c, 'SELECT * FROM issues')).toBe(0));
    } finally {
      await owner.query(`UPDATE workspace_members SET status = 'active' WHERE user_id = $1`, [U.kaijeaw]);
    }
  });

  it('เขียนแถวที่ระบุ workspace_id ของที่อื่นไม่ได้', async () => {
    await as(U.mick, WS1, async (c) => {
      await expect(
        c.query(`INSERT INTO labels (workspace_id, project_id, name) VALUES ($1, $2, 'x')`, [WS2, Q1]),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it('อ้างโปรเจกต์ของ Workspace อื่นไม่ได้ แม้ใส่ workspace_id ของตัวเอง', async () => {
    await as(U.mick, WS1, async (c) => {
      await expect(
        c.query(`INSERT INTO labels (workspace_id, project_id, name) VALUES ($1, $2, 'x')`, [WS1, Q1]),
      ).rejects.toThrow();
    });
  });

  it('เมนูสลับ Workspace เห็นเฉพาะ Workspace ที่ตัวเองเป็นสมาชิก', async () => {
    await as(U.mick, WS1, async (c) => {
      const { rows } = await c.query('SELECT slug FROM workspaces');
      expect(rows.map((r) => r.slug)).toEqual(['friday-dev']);
    });
  });

  it('เห็นข้อมูลผู้ใช้เฉพาะคนใน Workspace เดียวกัน', async () => {
    await as(U.outsider, WS2, async (c) => {
      expect(await count(c, 'SELECT * FROM users WHERE id = $1', [U.mick])).toBe(0);
    });
  });
});

describe('ชั้นที่ 2: เข้าถึงโปรเจกต์', () => {
  it('Member เห็นงานในโปรเจกต์ที่ตัวเองอยู่ และโปรเจกต์ที่เปิดทั้ง Workspace', async () => {
    await as(U.kaijeaw, WS1, async (c) => {
      expect(await count(c, 'SELECT * FROM issues WHERE project_id = $1', [P1])).toBe(2);
      expect(await count(c, 'SELECT * FROM issues WHERE project_id = $1', [P2])).toBe(1);
    });
  });

  it('Guest ที่ไม่ได้ถูกเชิญไม่เห็นงานเลย แม้โปรเจกต์เปิดทั้ง Workspace', async () => {
    await as(U.guest, WS1, async (c) => {
      expect(await count(c, 'SELECT * FROM issues')).toBe(0);
      expect(await count(c, 'SELECT * FROM projects')).toBe(0);
    });
  });

  it('Guest ที่ถูกเชิญเป็น Member ใน P1 เห็นงานของ P1 เท่านั้น', async () => {
    await as(U.freelance, WS1, async (c) => {
      expect(await count(c, 'SELECT * FROM issues WHERE project_id = $1', [P1])).toBe(2);
      expect(await count(c, 'SELECT * FROM issues WHERE project_id = $1', [P2])).toBe(0);
    });
  });

  it('Workspace Admin เห็นแถวโปรเจกต์ Private แต่เปิดงานและคอมเมนต์ไม่ได้', async () => {
    await as(U.arm, WS1, async (c) => {
      expect(await count(c, 'SELECT * FROM projects WHERE id = $1', [P1])).toBe(1);
      expect(await count(c, 'SELECT * FROM project_members WHERE project_id = $1', [P1])).toBe(3);
      expect(await count(c, 'SELECT * FROM issues WHERE project_id = $1', [P1])).toBe(0);
      expect(await count(c, 'SELECT * FROM comments')).toBe(0);
    });
  });

  it('Workspace Admin กด "เข้าร่วมในฐานะ Admin" แล้วเห็นงาน', async () => {
    await as(U.arm, WS1, async (c) => {
      await c.query(`INSERT INTO project_members (workspace_id, project_id, user_id, role) VALUES ($1, $2, $3, 'admin')`, [
        WS1,
        P1,
        U.arm,
      ]);
      expect(await count(c, 'SELECT * FROM issues WHERE project_id = $1', [P1])).toBe(2);
      expect(await count(c, 'SELECT * FROM comments')).toBe(1);
    });
  });

  it('Member ทั่วไปเพิ่มตัวเองเข้าโปรเจกต์ Private ไม่ได้', async () => {
    await owner.query(`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, [P1, U.kaijeaw]);
    try {
      await as(U.kaijeaw, WS1, async (c) => {
        await expect(
          c.query(`INSERT INTO project_members (workspace_id, project_id, user_id, role) VALUES ($1, $2, $3, 'member')`, [
            WS1,
            P1,
            U.kaijeaw,
          ]),
        ).rejects.toThrow(/row-level security/);
      });
    } finally {
      await owner.query(`INSERT INTO project_members (workspace_id, project_id, user_id, role) VALUES ($1, $2, $3, 'member')`, [
        WS1,
        P1,
        U.kaijeaw,
      ]);
    }
  });

  it('สร้างโปรเจกต์ใหม่ได้เมื่อใส่ตัวเองเป็น Project Owner', async () => {
    await as(U.kaijeaw, WS1, async (c) => {
      await c.query(
        `INSERT INTO projects (workspace_id, key, name, start_date, golive_date, owner_user_id)
         VALUES ($1, 'NEW', 'ใหม่', '2026-12-01', '2027-01-31', $2)`,
        [WS1, U.kaijeaw],
      );
      expect(await count(c, `SELECT * FROM projects WHERE key = 'NEW'`)).toBe(1);
    });
  });
});

describe('ตารางเฉพาะ', () => {
  it('แจ้งเตือนเห็นเฉพาะของตัวเอง', async () => {
    await as(U.kaijeaw, WS1, async (c) => expect(await count(c, 'SELECT * FROM notifications')).toBe(0));
    await as(U.mick, WS1, async (c) => expect(await count(c, 'SELECT * FROM notifications')).toBe(1));
  });

  it('Audit log เพิ่มได้ แต่แก้และลบไม่ได้', async () => {
    await as(U.mick, WS1, async (c) => {
      await c.query(
        `INSERT INTO audit_logs (workspace_id, actor_id, actor_kind, category, action) VALUES ($1, $2, 'user', 'perm', 'test')`,
        [WS1, U.mick],
      );
      await c.query('SAVEPOINT s');
      await expect(c.query(`UPDATE audit_logs SET action = 'x'`)).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK TO SAVEPOINT s');
      await expect(c.query(`DELETE FROM audit_logs`)).rejects.toThrow(/permission denied/);
    });
  });
});

describe('กติกาข้อมูล', () => {
  it('Sub-task ของ Sub-task สร้างไม่ได้ (ลึกสุด 2 ชั้น)', async () => {
    await as(U.mick, WS1, async (c) => {
      const sub = (await c.query('SELECT id FROM issues WHERE number = 526')).rows[0].id;
      await expect(
        c.query(
          `INSERT INTO issues (workspace_id, project_id, number, issue_type_id, status_id, title, parent_id)
           VALUES ($1, $2, 999, $3, $4, 'ลึกเกิน', $5)`,
          [WS1, P1, fx.p1.ty, fx.p1.st, sub],
        ),
      ).rejects.toThrow(/issue_depth_exceeded/);
    });
  });

  it('แก้งานแล้ว version เพิ่มขึ้น (ใช้ตรวจ If-Match)', async () => {
    await as(U.mick, WS1, async (c) => {
      const { rows } = await c.query(`UPDATE issues SET title = 'แก้' WHERE id = $1 RETURNING version`, [fx.p1Task]);
      expect(rows[0].version).toBe(2);
    });
  });

  it('อนุมัติคำขอเลื่อน Due ของตัวเองไม่ได้', async () => {
    await as(U.mick, WS1, async (c) => {
      await expect(
        c.query(
          `INSERT INTO due_change_requests (workspace_id, issue_id, requester_id, requested_due, reason_code, status, decided_by)
           VALUES ($1, $2, $3, '2026-12-04', 'scope_added', 'approved', $3)`,
          [WS1, fx.p1Task, U.mick],
        ),
      ).rejects.toThrow(/due_change_requests_not_self_decided/);
    });
  });
});

describe('withTenant (ตัวช่วยที่ API ใช้)', () => {
  it('ตั้งผู้ใช้ / Workspace เฉพาะในธุรกรรม และไม่รั่วไป connection ถัดไปใน pool', async () => {
    const db = createDb(APP_URL, 1);
    try {
      const inside = await withTenant(db, { userId: U.mick, workspaceId: WS1 }, (tx) => tx.select({ n: dCount() }).from(issues));
      expect(inside[0].n).toBe(3);
      // pool มี connection เดียว จึงเป็น connection เดิมแน่นอน
      const after = await db.select({ n: dCount() }).from(issues);
      expect(after[0].n).toBe(0);
    } finally {
      await db.$client.end();
    }
  });
});
