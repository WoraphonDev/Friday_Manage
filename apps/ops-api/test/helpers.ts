import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { expect } from 'vitest';
import { signEnrollToken } from '../src/auth/auth.service.js';
import { createApp } from '../src/bootstrap.js';
import { SoftKey } from './authenticator.js';

export const OWNER_URL = process.env.DATABASE_OWNER_URL ?? 'postgres://friday_owner:friday_owner_dev@localhost:54329/friday';

export interface TestOps {
  app: INestApplication;
  owner: pg.Client;
  close: () => Promise<void>;
}

/** ล้างทุกตารางแล้วเปิดแอปหลังบ้าน (ฐานข้อมูลเดียวกับ API ลูกค้า) */
export async function startOps(): Promise<TestOps> {
  const owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  const t = (await owner.query(`SELECT string_agg(format('public.%I', tablename), ', ') AS t FROM pg_tables WHERE schemaname = 'public'`)).rows[0].t;
  await owner.query(`TRUNCATE ${t} CASCADE`);
  const app = await createApp();
  await app.init();
  return { app, owner, close: async () => { await app.close(); await owner.end(); } };
}

/** พนักงานหนึ่งคน = agent + Security key จำลอง */
export async function staff(t: TestOps, email: string, name: string, role: 'admin' | 'support' | 'finance') {
  const row = await t.owner.query(`INSERT INTO staff_users (email, name, role) VALUES ($1, $2, $3) RETURNING id`, [email, name, role]);
  const id = row.rows[0].id as string;
  const key = new SoftKey();
  const agent = request.agent(t.app.getHttpServer());
  const opt = await agent.post('/ops/auth/register/options').send({ enrollToken: signEnrollToken(id) });
  expect(opt.status, JSON.stringify(opt.body)).toBe(200);
  const reg = await agent.post('/ops/auth/register/verify').send({ challengeToken: opt.body.challengeToken, response: key.register(opt.body.options) });
  expect(reg.status, JSON.stringify(reg.body)).toBe(200);
  const login = await signIn(agent, email, key);
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return { id, email, name, role, key, agent };
}

export async function signIn(agent: ReturnType<typeof request.agent>, email: string, key: SoftKey) {
  const o = await agent.post('/ops/auth/login/options').send({ email });
  expect(o.status).toBe(200);
  return agent.post('/ops/auth/login/verify').send({ challengeToken: o.body.challengeToken, response: key.assert(o.body.options) });
}
export type Staff = Awaited<ReturnType<typeof staff>>;

/** Workspace ลูกค้าสมมติ: เจ้าของ + (ตัวเลือก) แพ็กเกจ */
export async function customer(t: TestOps, slug: string, opts: { plan?: string; status?: 'trialing' | 'active' | 'canceled' | 'past_due'; cycle?: 'monthly' | 'yearly'; trialDays?: number; admins?: string[] } = {}) {
  const ws = (await t.owner.query(`INSERT INTO workspaces (slug, name) VALUES ($1, $2) RETURNING id`, [slug, `Co ${slug}`])).rows[0].id as string;
  const mk = async (email: string, role: string) => {
    const u = (await t.owner.query(`INSERT INTO users (email, display_name) VALUES ($1, $2) ON CONFLICT (lower(email)) DO UPDATE SET email = excluded.email RETURNING id`, [email, email.split('@')[0]])).rows[0].id as string;
    await t.owner.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)`, [ws, u, role]);
    return u;
  };
  const owner = await mk(`owner@${slug}.example.com`, 'owner');
  for (const a of opts.admins ?? []) await mk(a, 'admin');
  await t.owner.query(`INSERT INTO plans (code) VALUES ('free'), ('team_s'), ('team_m'), ('team_l'), ('enterprise') ON CONFLICT (code) DO NOTHING`);
  const plan = (await t.owner.query(`SELECT id FROM plans WHERE code = $1`, [opts.plan ?? 'team_s'])).rows[0].id;
  const status = opts.status ?? 'trialing';
  const trialEnds = status === 'trialing' ? new Date(Date.now() + (opts.trialDays ?? 14) * 86_400_000) : null;
  const sub = (await t.owner.query(`INSERT INTO subscriptions (workspace_id, plan_id, cycle, status, trial_ends_at, current_period_start, current_period_end) VALUES ($1,$2,$3,$4,$5, now() - interval '5 days', now() + interval '25 days') RETURNING id`, [ws, plan, opts.cycle ?? 'monthly', status, trialEnds])).rows[0].id as string;
  return { id: ws, slug, owner, sub };
}
export type Customer = Awaited<ReturnType<typeof customer>>;
