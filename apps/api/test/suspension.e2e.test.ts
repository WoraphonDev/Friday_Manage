// C6 · Workspace ที่ถูกระงับ: อ่านอย่างเดียว / ปิดทั้งหมด · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedTeam, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let wsId: string;

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t, { slug: 'suspend-co' });
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
});
afterAll(() => t.close());

const suspend = (mode: 'read_only' | 'full' | null, message: string | null = null) =>
  t.owner.query(`UPDATE workspaces SET status = $2, suspension_mode = $3, suspension_message = $4 WHERE id = $1`, [wsId, mode ? 'suspended' : 'active', mode, message]);
const issue = () => team.dev.post(`${team.ws}/projects/${team.key}/issues`, { title: 'ทดสอบตอนระงับ', moduleId: team.project.modules[0].id });

describe('ระงับแบบอ่านอย่างเดียว', () => {
  it('อ่านได้ · เขียนไม่ได้ (403 workspace_suspended) · ชำระเงิน / ส่งออก / สิทธิ์ช่วยเหลือยังทำได้', async () => {
    expect((await issue()).status).toBe(201);
    await suspend('read_only', 'ค้างชำระ FRI-0001 กรุณาชำระเพื่อใช้งานต่อ');
    const w = await team.dev.get(team.ws);
    expect(w.status).toBe(200);
    expect(w.body.suspension).toEqual({ mode: 'read_only', message: 'ค้างชำระ FRI-0001 กรุณาชำระเพื่อใช้งานต่อ' });
    expect((await team.dev.get(`${team.ws}/projects/${team.key}`)).status).toBe(200);
    const blocked = await issue();
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatchObject({ code: 'workspace_suspended', details: { mode: 'read_only' } });
    expect((await team.lead.patch(team.ws, { name: 'เปลี่ยนชื่อ' })).body.error.code).toBe('workspace_suspended');
    // ทางที่ยังใช้ได้: ไม่ติด workspace_suspended (อาจติดเงื่อนไขอื่นของ endpoint เอง)
    for (const r of [await team.lead.post(`${team.ws}/exports`), await team.lead.put(`${team.ws}/billing/profile`, {}), await team.lead.post(`${team.ws}/events`, { events: [] })]) {
      expect(r.body?.error?.code, JSON.stringify(r.body)).not.toBe('workspace_suspended');
    }
  });
});

describe('ระงับแบบปิดทั้งหมด', () => {
  it('สมาชิกเข้าไม่ได้เลย · Owner เห็นเฉพาะข้อมูล Workspace (หน้าติดต่อทีม) และหน้าชำระเงิน / ส่งออก', async () => {
    await suspend('full', 'ผิดข้อตกลงการใช้งาน กรุณาติดต่อทีม Friday');
    const dev = await team.dev.get(team.ws);
    expect(dev.status).toBe(403);
    expect(dev.body.error).toMatchObject({ code: 'workspace_suspended', details: { mode: 'full' } });
    expect((await team.dev.get(`/me/notifications?workspace=${team.slug}`)).body.error.code).toBe('workspace_suspended');
    const lead = await team.lead.get(team.ws);
    expect(lead.status).toBe(200);
    expect(lead.body.suspension).toEqual({ mode: 'full', message: 'ผิดข้อตกลงการใช้งาน กรุณาติดต่อทีม Friday' });
    expect((await team.lead.get(`${team.ws}/projects/${team.key}`)).body.error.code).toBe('workspace_suspended');
    expect((await team.lead.get(`${team.ws}/billing`)).body?.error?.code).not.toBe('workspace_suspended');
    expect((await team.lead.get(`${team.ws}/usage`)).body?.error?.code).not.toBe('workspace_suspended');
    expect((await team.lead.get(`${team.ws}/exports`)).status).toBe(200);
  });

  it('เปิดใช้งานอีกครั้ง → กลับมาปกติ', async () => {
    await suspend(null);
    expect((await team.dev.get(team.ws)).body.suspension).toBeNull();
    expect((await issue()).status).toBe(201);
  });
});
