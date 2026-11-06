// ตัวช่วยของ test ที่ใช้ฐานข้อมูลจริง · แต่ละไฟล์ test เริ่มจากฐานข้อมูลว่าง (startApp ล้างทุกตาราง)
// vitest รันทีละไฟล์ (fileParallelism: false) จึงไม่ชนกัน
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { expect } from 'vitest';
import { createApp } from '../src/bootstrap.js';

export const OWNER_URL = process.env.DATABASE_OWNER_URL ?? 'postgres://friday_owner:friday_owner_dev@localhost:54329/friday';

export interface TestApp {
  app: INestApplication;
  /** เจ้าของตาราง (ข้าม RLS) ใช้เตรียม / ตรวจข้อมูลตรงในฐานข้อมูล */
  owner: pg.Client;
  close: () => Promise<void>;
}

/** ล้างทุกตารางแล้วเปิดแอป · เรียกใน beforeAll และเรียก close ใน afterAll */
export async function startApp(): Promise<TestApp> {
  const owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  const t = (await owner.query(`SELECT string_agg(format('public.%I', tablename), ', ') AS t FROM pg_tables WHERE schemaname = 'public'`)).rows[0].t;
  await owner.query(`TRUNCATE ${t} CASCADE`);
  const app = await createApp();
  await app.init();
  return {
    app,
    owner,
    close: async () => {
      await app.close();
      await owner.end();
    },
  };
}

/** ผู้ใช้ 1 คน = agent ที่จำคุกกี้ + CSRF token */
export async function client(app: INestApplication) {
  const agent = request.agent(app.getHttpServer());
  const { body } = await agent.get('/api/v1/auth/csrf');
  const h = { 'x-csrf-token': body.csrfToken as string };
  return {
    agent,
    get: (url: string) => agent.get(`/api/v1${url}`),
    post: (url: string, data?: object) => agent.post(`/api/v1${url}`).set(h).send(data),
    put: (url: string, data?: object) => agent.put(`/api/v1${url}`).set(h).send(data),
    delete: (url: string, data?: object) => agent.delete(`/api/v1${url}`).set(h).send(data),
    upload: (url: string, file: Buffer, name: string, fields: Record<string, string> = {}) => {
      const r = agent.post(`/api/v1${url}`).set(h);
      for (const [k, v] of Object.entries(fields)) r.field(k, v);
      return r.attach('file', file, name);
    },
    patch: (url: string, data: object, ifMatch?: string | number) => {
      const r = agent.patch(`/api/v1${url}`).set(h);
      return (ifMatch === undefined ? r : r.set('If-Match', `"${ifMatch}"`)).send(data);
    },
  };
}
export type Client = Awaited<ReturnType<typeof client>>;

export async function signup(c: Client, email: string, name: string) {
  const r = await c.post('/auth/signup', { email, password: 'Friday2026', displayName: name, acceptTerms: true });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

/** เพิ่มสมาชิกตรงในฐานข้อมูล (เร็วกว่าเชิญ + ตอบรับ) */
export async function addMember(owner: pg.Client, wsSlug: string, userId: string, role: 'owner' | 'admin' | 'member' | 'guest', project?: { key: string; role: 'admin' | 'member' | 'viewer' }) {
  const { rows } = await owner.query('SELECT id FROM workspaces WHERE slug = $1', [wsSlug]);
  await owner.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)', [rows[0].id, userId, role]);
  if (project) {
    await owner.query(
      `INSERT INTO project_members (workspace_id, project_id, user_id, role)
       SELECT workspace_id, id, $2, $3 FROM projects WHERE workspace_id = $1 AND key = $4`,
      [rows[0].id, userId, project.role, project.key],
    );
  }
}

/** ปฏิทินวันหยุดตัวอย่าง: 7 และ 10 ธ.ค. 2569 */
export async function seedHolidays(owner: pg.Client) {
  const { rows } = await owner.query(`INSERT INTO holiday_calendars (name, source) VALUES ('ธปท. 2569', 'bot') RETURNING id`);
  await owner.query(`INSERT INTO holidays (calendar_id, date, name) VALUES ($1, '2026-12-07', 'ชดเชยวันพ่อ'), ($1, '2026-12-10', 'วันรัฐธรรมนูญ')`, [rows[0].id]);
  await owner.query(`UPDATE workspace_settings SET holiday_calendar_id = $1`, [rows[0].id]);
}

/**
 * จุดเริ่มของไฟล์ test ใหม่: Lead (Owner ของ Workspace + PM) และ Dev (Member) ในโปรเจกต์ DP
 * ข้อมูลสมมติเท่านั้น · ห้ามใช้ข้อมูลจริงของที่ทำงาน
 */
export async function seedTeam(t: TestApp, opts: { slug?: string; key?: string; withDefaultRules?: boolean } = {}) {
  const slug = opts.slug ?? 'friday-dev';
  const key = opts.key ?? 'DP';
  const lead = await client(t.app);
  const dev = await client(t.app);
  const leadId = await signup(lead, `lead@${slug}.example.com`, 'Mick');
  const devId = await signup(dev, `dev@${slug}.example.com`, 'Kaijeaw');
  expect((await lead.post('/workspaces', { name: 'Friday', slug })).status).toBe(201);
  await seedHolidays(t.owner);
  const p = await lead.post(`/w/${slug}/projects`, {
    name: 'Development Plan',
    key,
    startDate: '2026-11-05',
    goliveDate: '2027-04-21',
    modules: ['Credit Line', 'Drawdown'],
    milestones: [{ name: 'Credit Line Go-live', date: '2027-01-26' }],
  });
  expect(p.status).toBe(201);
  // โปรเจกต์ใหม่ได้กฎ Workflow ค่าเริ่มต้น (BUG-10) · fixture ร่วมเริ่มจากไม่มีกฎ เพื่อให้ test ที่ไม่ได้ทดสอบกฎไม่ต้องตั้ง Reviewer / หลักฐาน
  // test ของกฎเองเพิ่มแถวตามต้องการ · ค่าเริ่มต้นของโปรเจกต์ใหม่ตรวจใน project-structure.e2e.test.ts
  if (opts.withDefaultRules !== true) await t.owner.query('DELETE FROM workflow_rules WHERE project_id = $1', [p.body.id]);
  await addMember(t.owner, slug, devId, 'member', { key, role: 'member' });
  const project = (await lead.get(`/w/${slug}/projects/${key}`)).body;
  return { slug, key, lead, leadId, dev, devId, project, ws: `/w/${slug}` };
}
