// BUG-09 · Guest Member (Workspace guest + Project member) ใช้สิทธิ์ของ Member · Guest Viewer เห็นเฉพาะ Overview / Timeline
// ข้อห้ามของ Guest ทุกแบบ (Settings, รายชื่อคนทั้งองค์กร) ต้องยังอยู่ · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let guestViewer: Client;
let guestMember: Client;
let base: string;

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  base = `${team.ws}/projects/${team.key}`;
  guestViewer = await client(t.app);
  await addMember(t.owner, team.slug, await signup(guestViewer, 'client@guest-matrix.example.com', 'ลูกค้า'), 'guest', { key: team.key, role: 'viewer' });
  guestMember = await client(t.app);
  await addMember(t.owner, team.slug, await signup(guestMember, 'contractor@guest-matrix.example.com', 'Dev outsource'), 'guest', { key: team.key, role: 'member' });
});
afterAll(() => t.close());

const month = '2026-12';
const endpoints: Array<[string, (c: Client) => ReturnType<Client['get']>]> = [
  ['files', (c) => c.get(`${base}/files`)],
  ['calendar', (c) => c.get(`${base}/calendar?month=${month}`)],
  ['gantt', (c) => c.get(`${base}/gantt`)],
  ['insights/risks', (c) => c.get(`${base}/insights/risks`)],
  ['insights/modules', (c) => c.get(`${base}/insights/modules`)],
  ['saved-views', (c) => c.get(`${base}/saved-views`)],
  ['repositories', (c) => c.get(`${base}/repositories`)],
  ['schedule/preview', (c) => c.post(`${base}/schedule/preview`, {})],
];

describe('Workspace guest × Project role', () => {
  it.each(endpoints)('%s: Guest Member ได้ผลเท่า Member · Guest Viewer ได้ 403', async (_name, call) => {
    const gm = await call(guestMember);
    expect(gm.body?.error?.code, JSON.stringify(gm.body)).not.toBe('guest_view_limited');
    // ผลต้องเท่ากับ Member ปกติ (dev) ไม่ว่าจะได้ข้อมูลหรือถูกปฏิเสธด้วยสิทธิ์ของ Member
    const member = await call(team.dev);
    expect(gm.status).toBe(member.status);
    const gv = await call(guestViewer);
    expect(gv.status).toBe(403);
    // บาง endpoint ตรวจสิทธิ์ที่ Viewer ไม่มีก่อน (forbidden) · ทั้งสองแบบคือถูกปฏิเสธ
    expect(['guest_view_limited', 'forbidden']).toContain(gv.body.error.code);
  });

  it('Guest Member เห็นไฟล์และอัปโหลดได้ตามสิทธิ์ Member (R06)', async () => {
    expect((await guestMember.get(`${base}/my-permissions`)).body.permissions).toContain('file.upload');
    expect((await guestMember.get(`${base}/files`)).status).toBe(200);
    expect((await guestMember.post(`${base}/files/upload-url`, { name: 'งานส่ง.txt', size: 3, mime: 'text/plain' })).status).toBe(200);
  });

  it('ข้อห้ามของ Guest ทุกแบบยังอยู่: Settings ของโปรเจกต์ และรายชื่อคนทั้งองค์กร', async () => {
    const version = (await team.lead.get(base)).body.version;
    for (const c of [guestMember, guestViewer]) {
      expect((await c.patch(base, { name: 'เปลี่ยนชื่อ' }, version)).status).toBe(403);
      expect((await c.get(`${team.ws}/members`)).status).toBe(403);
    }
  });
});
