// O42 · Legal hold และนโยบายการเก็บข้อมูลในงานลบถาวรฝั่ง API ลูกค้า · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RetentionService } from '../src/privacy/retention.service.js';
import { WorkspaceLifecycleService } from '../src/privacy/lifecycle.service.js';
import { TrashPurgeService } from '../src/trash/purge.service.js';
import { seedTeam, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let staffId = '';

const one = async <T = Record<string, unknown>>(q: string, p: unknown[] = []) => (await t.owner.query(q, p)).rows[0] as T;
const exists = async (table: string, id: string) => (await t.owner.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount === 1;

/** Workspace สมมติที่ลบไว้และพ้นวันลบถาวรแล้ว */
async function deletedWorkspace(slug: string) {
  const id = (await one<{ id: string }>(`INSERT INTO workspaces (slug, name) VALUES ($1, $2) RETURNING id`, [slug, `Co ${slug}`])).id;
  await t.owner.query(`UPDATE workspaces SET deleted_at = now() - interval '31 days', status = 'pending_delete' WHERE id = $1`, [id]);
  await t.owner.query(`UPDATE workspaces SET purge_after = now() - interval '1 hour' WHERE id = $1`, [id]);
  return id;
}
async function hold(workspaceId: string, opts: { scope?: 'workspace' | 'users'; userIds?: string[] } = {}) {
  return (await one<{ id: string }>(
    `INSERT INTO legal_holds (workspace_id, scope, user_ids, reason, reference, created_by) VALUES ($1, $2, $3, 'ข้อพิพาทการชำระเงิน (สมมติ)', 'คดีสมมติ 001', $4) RETURNING id`,
    [workspaceId, opts.scope ?? 'workspace', opts.userIds ?? [], staffId],
  )).id;
}
const release = (id: string) => t.owner.query(`UPDATE legal_holds SET released_at = now(), released_by = $2, release_reason = 'คดีสิ้นสุด (สมมติ)' WHERE id = $1`, [id, staffId]);

beforeAll(async () => {
  t = await startApp();
  staffId = (await one<{ id: string }>(`INSERT INTO staff_users (email, name, roles) VALUES ('owner@friday.example.com', 'Olive Owner', '{owner}') RETURNING id`)).id;
});
afterAll(() => t.close());

describe('privacy.purge-workspaces · Legal hold', () => {
  it('ข้าม Workspace ที่ติด hold (ทั้งก้อนหรือเฉพาะผู้ใช้) · ยกเลิก hold แล้วลบได้ แม้มีประวัติ hold ที่ยกเลิกแล้ว', async () => {
    const svc = t.app.get(WorkspaceLifecycleService);
    const a = await deletedWorkspace('held-whole');
    const b = await deletedWorkspace('held-users');
    const c = await deletedWorkspace('free-to-go');
    const user = (await one<{ id: string }>(`INSERT INTO users (email, display_name) VALUES ('person@held.example.com', 'Person') RETURNING id`)).id;
    const ha = await hold(a);
    await hold(b, { scope: 'users', userIds: [user] });

    expect(await svc.purge()).toEqual({ purged: 1, held: 2 });
    expect(await exists('workspaces', a)).toBe(true);
    expect(await exists('workspaces', b)).toBe(true);
    expect(await exists('workspaces', c)).toBe(false);

    await release(ha);
    expect((await svc.purge()).purged).toBe(1);
    expect(await exists('workspaces', a)).toBe(false);
    expect((await t.owner.query(`SELECT 1 FROM legal_holds WHERE workspace_id = $1`, [a])).rowCount).toBe(0);
    expect(await exists('workspaces', b)).toBe(true);
  });

  it('privacy.purge-approved: ลบเฉพาะที่ทีม Friday อนุมัติลบทันที (audit ops.workspace_purge_approved) และยังเคารพ hold', async () => {
    const svc = t.app.get(WorkspaceLifecycleService);
    const approved = await deletedWorkspace('approved-now');
    const other = await deletedWorkspace('waits-for-4am');
    const heldApproved = await deletedWorkspace('approved-but-held');
    for (const id of [approved, heldApproved]) {
      await t.owner.query(`INSERT INTO audit_logs (workspace_id, actor_kind, category, action, summary) VALUES ($1, 'friday_staff', 'secu', 'ops.workspace_purge_approved', 'อนุมัติลบถาวรทันที (สมมติ)')`, [id]);
    }
    await hold(heldApproved);
    expect(await svc.purge(new Date(), { approvedOnly: true })).toEqual({ purged: 1, held: 1 });
    expect(await exists('workspaces', approved)).toBe(false);
    expect(await exists('workspaces', other)).toBe(true);
    expect(await exists('workspaces', heldApproved)).toBe(true);
  });
});

describe('trash.purge · Legal hold และระยะเก็บที่ทีม Friday ตั้ง', () => {
  it('Workspace ที่ไม่ได้ตั้ง trash_days ใช้ retention.trashDays · Workspace ที่ติด hold ไม่ถูกลบ', async () => {
    const team = await seedTeam(t, { slug: 'trash-free' });
    const other = await seedTeam(t, { slug: 'trash-held', key: 'TH' });
    const p1 = team.project.id as string;
    const p2 = other.project.id as string;
    await t.owner.query(`UPDATE projects SET deleted_at = now() - interval '20 days' WHERE id = ANY($1)`, [[p1, p2]]);
    const svc = t.app.get(TrashPurgeService);
    // ค่าเริ่มต้น 30 วัน: ยังไม่ครบ
    expect((await svc.purge()).projects).toBe(0);

    await t.owner.query(`INSERT INTO ops_settings (key, value) VALUES ('retention', '{"trashDays": 14}')`);
    const heldWs = (await one<{ id: string }>(`SELECT id FROM workspaces WHERE slug = 'trash-held'`)).id;
    await hold(heldWs);
    expect((await svc.purge()).projects).toBe(1);
    expect(await exists('projects', p1)).toBe(false);
    expect(await exists('projects', p2)).toBe(true);
    await t.owner.query(`DELETE FROM ops_settings WHERE key = 'retention'`);
  });
});

describe('privacy.retention-logs', () => {
  it('ล้าง IP / User agent ที่เก่ากว่า systemLogDays · ข้าม Workspace ที่ติด hold · ลบ session ที่จบแล้ว · บันทึก retention_last_run', async () => {
    const free = (await one<{ id: string }>(`INSERT INTO workspaces (slug, name) VALUES ('logs-free', 'Logs Free') RETURNING id`)).id;
    const held = (await one<{ id: string }>(`INSERT INTO workspaces (slug, name) VALUES ('logs-held', 'Logs Held') RETURNING id`)).id;
    await hold(held);
    const log = async (ws: string, ageDays: number) =>
      (await one<{ id: string }>(
        `INSERT INTO audit_logs (workspace_id, actor_kind, category, action, summary, ip, user_agent, created_at) VALUES ($1, 'user', 'secu', 'auth.login', 'เข้าสู่ระบบ (สมมติ)', '192.0.2.10', 'TestAgent/1.0', now() - make_interval(days => $2)) RETURNING id`,
        [ws, ageDays],
      )).id;
    const oldFree = await log(free, 40);
    const newFree = await log(free, 5);
    const oldHeld = await log(held, 40);
    await t.owner.query(`INSERT INTO ops_settings (key, value) VALUES ('retention', '{"systemLogDays": 30}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);

    const u1 = (await one<{ id: string }>(`INSERT INTO users (email, display_name) VALUES ('old-session@logs.example.com', 'Old') RETURNING id`)).id;
    const u2 = (await one<{ id: string }>(`INSERT INTO users (email, display_name) VALUES ('held-member@logs.example.com', 'Held') RETURNING id`)).id;
    await t.owner.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [held, u2]);
    const sess = async (userId: string, sql: string) => (await one<{ id: string }>(`INSERT INTO user_sessions (user_id, token_hash, ${sql}) RETURNING id`, [userId])).id;
    const revokedOld = await sess(u1, `revoked_at, last_seen_at) VALUES ($1, 'hash-old-1', now() - interval '40 days', now() - interval '40 days'`);
    const idleRemembered = await sess(u1, `last_seen_at, remember_until) VALUES ($1, 'hash-old-2', now() - interval '40 days', now() + interval '5 days'`);
    const heldOld = await sess(u2, `revoked_at, last_seen_at) VALUES ($1, 'hash-old-3', now() - interval '40 days', now() - interval '40 days'`);

    const r = await t.app.get(RetentionService).purgeLogs();
    expect(r).toEqual({ logRows: 1, sessionRows: 1, systemLogDays: 30 });
    const ip = async (id: string) => (await one<{ ip: string | null; user_agent: string | null }>(`SELECT ip, user_agent FROM audit_logs WHERE id = $1`, [id]));
    expect(await ip(oldFree)).toEqual({ ip: null, user_agent: null });
    expect((await ip(newFree)).ip).toBe('192.0.2.10');
    expect((await ip(oldHeld)).ip).toBe('192.0.2.10');
    expect(await exists('user_sessions', revokedOld)).toBe(false);
    expect(await exists('user_sessions', idleRemembered)).toBe(true);
    expect(await exists('user_sessions', heldOld)).toBe(true);
    const last = (await one<{ value: Record<string, unknown> }>(`SELECT value FROM ops_settings WHERE key = 'retention_last_run'`)).value;
    expect(last).toMatchObject({ logRows: 1, sessionRows: 1, systemLogDays: 30 });
    expect(typeof last.at).toBe('string');
  });
});
