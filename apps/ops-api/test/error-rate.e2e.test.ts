// O43 · Error rate เกิน → แจ้ง Push / อีเมล → รับทราบ → กลับมาปกติ (S10–S12) + บันทึกผล Push · ข้อมูลสมมติเท่านั้น
import { createECDH, randomBytes } from 'node:crypto';
import type { Db } from '@friday/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mailer } from '../src/mail.js';
import { PushService } from '../src/push/push.service.js';
import { AlertsService, type TrafficSnapshot } from '../src/system/alerts.service.js';
import { staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let mail: Mailer;
let push: PushService;
let alerts: AlertsService;
let owner: Staff;
let engineer: Staff;
let support: Staff;
let finance: Staff;
const delivered: { endpoint: string; payload: Record<string, string> }[] = [];
let failing = new Set<string>();

const browserKeys = () => {
  const e = createECDH('prime256v1');
  e.generateKeys();
  return { p256dh: e.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
};
const T0 = Date.parse('2026-11-16T03:46:00Z');
const at = (min: number) => new Date(T0 + min * 60_000);
/** ผลอ่านตัวนับของ API ลูกค้าแบบสมมติ */
const snap = (errors: number, total: number, min = 0): TrafficSnapshot => ({
  windowMin: 5,
  total,
  errors,
  ratePct: total ? Math.round((errors / total) * 10_000) / 100 : null,
  topRoute: errors ? { route: 'POST /w/:ws/issues', errors } : null,
  p95Ms: 412,
  minutes: [{ at: new Date(T0 + min * 60_000 - (T0 % 60_000)).toISOString(), total, errors, topRoute: errors ? 'POST /w/:ws/issues' : null }],
});
const alertRows = async () => (await t.owner.query(`SELECT * FROM system_alerts ORDER BY started_at`)).rows;

beforeAll(async () => {
  t = await startOps();
  mail = t.app.get(Mailer);
  push = t.app.get(PushService);
  alerts = t.app.get(AlertsService);
  push.sender = async (sub, payload) => {
    if (failing.has(sub.endpoint)) throw Object.assign(new Error('Service Unavailable'), { statusCode: 503 });
    delivered.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    return { statusCode: 201, body: '', headers: {} };
  };
  owner = await staff(t, 'owner@friday.example.com', 'Olive Owner', ['owner']);
  engineer = await staff(t, 'eng@friday.example.com', 'Eve Engineer', ['engineer']);
  support = await staff(t, 'sup@friday.example.com', 'Sam Support', 'support');
  finance = await staff(t, 'fin@friday.example.com', 'Fin Finance', 'finance');
  for (const [who, ep] of [[owner, 'owner-phone'], [engineer, 'eng-phone'], [support, 'sup-phone']] as const) {
    const r = await who.agent.post('/ops/push/subscriptions').send({ endpoint: `https://push.example.com/${ep}`, keys: browserKeys(), userAgent: 'Android Chrome (ทดสอบ)' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
});
afterAll(() => t.close());

describe('ตั้งเกณฑ์แจ้งเตือน (S11)', () => {
  it('ค่าเริ่มต้นตามข้อเสนอ · Owner / วิศวกรแก้ได้ ลง Audit · บทบาทอื่นไม่ได้ · ค่าผิดรูป 400', async () => {
    expect((await engineer.agent.get('/ops/system/alert-settings')).body.settings).toEqual({ thresholdPct: 2, windowMin: 5, minRequests: 200, push: true, email: true, autoIncident: false });
    expect((await support.agent.get('/ops/system/alert-settings')).status).toBe(403);
    expect((await finance.agent.put('/ops/system/alert-settings').send({ thresholdPct: 3, windowMin: 5, minRequests: 200, push: true, email: true, autoIncident: false })).status).toBe(403);
    expect((await engineer.agent.put('/ops/system/alert-settings').send({ thresholdPct: 0, windowMin: 5, minRequests: 200, push: true, email: true, autoIncident: false })).status).toBe(400);
    expect((await engineer.agent.put('/ops/system/alert-settings').send({ thresholdPct: 2, windowMin: 7, minRequests: 200, push: true, email: true, autoIncident: false })).status).toBe(400);
    const r = await owner.agent.put('/ops/system/alert-settings').send({ thresholdPct: 2.5, windowMin: 10, minRequests: 100, push: true, email: false, autoIncident: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ saved: true, settings: { thresholdPct: 2.5, windowMin: 10 } });
    const audit = (await t.owner.query(`SELECT reason FROM staff_audit_logs WHERE action = 'system.alerts_updated'`)).rows;
    expect(audit[0].reason).toContain('เกณฑ์ 2% → 2.5%');
    expect(audit[0].reason).toContain('ปิดอีเมล');
    // คืนค่าเริ่มต้นให้ข้อถัดไป
    await owner.agent.put('/ops/system/alert-settings').send({ thresholdPct: 2, windowMin: 5, minRequests: 200, push: true, email: true, autoIncident: false }).expect(200);
  });
});

describe('Error rate เกิน → แจ้ง → รับทราบ → กลับมาปกติ', () => {
  let alertId: string;

  it('คำขอน้อยกว่าขั้นต่ำไม่นับ · ต่ำกว่าเกณฑ์ไม่แจ้ง', async () => {
    expect((await alerts.ingest(snap(50, 150), at(0))).state).toBe('normal');
    expect((await alerts.ingest(snap(100, 6290), at(1))).state).toBe('normal');
    expect(await alertRows()).toEqual([]);
  });

  it('เกินเกณฑ์ → เปิด system_alert · Push ถึงวิศวกรและ Owner (ไม่ถึง Support) · อีเมลวิศวกรและ Owner', async () => {
    const before = { push: delivered.length, mail: mail.sent.length };
    const r = await alerts.ingest(snap(214, 6290), at(2));
    expect(r).toMatchObject({ state: 'opened', notified: 'open' });
    alertId = r.alertId!;
    const [row] = await alertRows();
    expect(row).toMatchObject({ kind: 'error_rate', resolved_at: null, details: { ratePct: 3.4, errors: 214, total: 6290, topRoute: 'POST /w/:ws/issues', thresholdPct: 2 } });
    const sent = delivered.slice(before.push);
    expect(sent.map((d) => d.endpoint).sort()).toEqual(['https://push.example.com/eng-phone', 'https://push.example.com/owner-phone']);
    expect(sent[0].payload).toMatchObject({ title: 'Error rate เกิน 3.4%', body: '5xx 214 ครั้งใน 5 นาที · POST /w/:ws/issues · แตะเพื่อเปิด', url: `/m/incidents?alert=${alertId}` });
    expect(mail.sent.slice(before.mail).map((m) => m.to).sort()).toEqual(['eng@friday.example.com', 'owner@friday.example.com']);
    expect(mail.sent.at(-1)!.subject).toBe('[Friday Ops] Error rate เกิน 3.4%');
    // ค่าเริ่มต้นไม่เปิดเหตุขัดข้องเอง
    expect(row.incident_id).toBeNull();
  });

  it('ยังเกิน: ไม่แจ้งซ้ำก่อน 30 นาที · ครบ 30 นาทีแจ้งซ้ำ', async () => {
    const n = delivered.length;
    expect((await alerts.ingest(snap(300, 6000), at(12))).notified).toBeNull();
    expect(delivered.length).toBe(n);
    const r = await alerts.ingest(snap(260, 6100), at(32));
    expect(r.notified).toBe('repeat');
    expect(delivered.at(-1)!.payload.title).toBe('Error rate ยังเกิน 4.26%');
    expect((await alertRows())[0].details.peakPct).toBe(5);
  });

  it('หน้าสถานะระบบ: การ์ด Error rate · เกินมากี่นาที · กราฟ 24 ช่อง แท่งที่เกินเกณฑ์', async () => {
    const r = await engineer.agent.get('/ops/system/status');
    expect(r.status).toBe(200);
    expect(r.body.api.errorRate).toMatchObject({ ratePct: 4.26, errors: 260, total: 6100, thresholdPct: 2, over: true, topRoute: 'POST /w/:ws/issues' });
    expect(r.body.api.errorHours).toHaveLength(24);
    expect(r.body.api.alert).toMatchObject({ id: alertId, acknowledgedBy: null });
    expect(r.body.api.alertSettings.thresholdPct).toBe(2);
  });

  it('รับทราบ (S12): วิศวกร / Owner เท่านั้น · บอกคนอื่น · หลังรับทราบไม่แจ้งซ้ำ', async () => {
    expect((await support.agent.post(`/ops/system/alerts/${alertId}/acknowledge`)).status).toBe(403);
    const n = delivered.length;
    const r = await engineer.agent.post(`/ops/system/alerts/${alertId}/acknowledge`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ acknowledgedBy: engineer.id, already: false });
    expect(delivered.slice(n)).toEqual([{ endpoint: 'https://push.example.com/owner-phone', payload: expect.objectContaining({ title: 'Eve Engineer รับทราบ Error rate เกินแล้ว', tag: `alert-${alertId}` }) }]);
    expect((await owner.agent.post(`/ops/system/alerts/${alertId}/acknowledge`)).body.already).toBe(true);
    const m = delivered.length;
    expect((await alerts.ingest(snap(260, 6100), at(70))).notified).toBeNull();
    expect(delivered.length).toBe(m);
    const list = await support.agent.get('/ops/system/alerts');
    expect(list.body.open).toMatchObject({ id: alertId, acknowledgedBy: { id: engineer.id, name: 'Eve Engineer' } });
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM staff_audit_logs WHERE action = 'system.alert_acknowledged'`)).rows[0].n).toBe(1);
  });

  it('เปิดเหตุขัดข้องภายในจากการแจ้งเตือน · กดซ้ำได้อันเดิม · การเงินไม่ได้', async () => {
    expect((await finance.agent.post(`/ops/system/alerts/${alertId}/incident`)).status).toBe(403);
    const r = await support.agent.post(`/ops/system/alerts/${alertId}/incident`);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.created).toBe(true);
    const inc = (await t.owner.query(`SELECT title, internal, services FROM incidents WHERE id = $1`, [r.body.incidentId])).rows[0];
    expect(inc).toEqual({ title: 'Error rate เกิน 5%', internal: true, services: ['api'] });
    expect((await engineer.agent.post(`/ops/system/alerts/${alertId}/incident`)).body).toEqual({ incidentId: r.body.incidentId, created: false });
  });

  it('กลับมาปกติ: ยังไม่ครบ 10 นาทีไม่ปิด · เกินอีกครั้งนับใหม่ · ครบ 10 นาทีปิดและแจ้ง "กลับมาปกติ"', async () => {
    expect((await alerts.ingest(snap(10, 6000), at(71))).state).toBe('recovering');
    expect((await alerts.ingest(snap(10, 6000), at(78))).state).toBe('recovering');
    expect((await alerts.ingest(snap(400, 6000), at(79))).state).toBe('over');
    expect((await alerts.ingest(snap(10, 6000), at(80))).state).toBe('recovering');
    expect((await alerts.ingest(snap(10, 6000), at(89))).state).toBe('recovering');
    const n = delivered.length;
    const r = await alerts.ingest(snap(10, 6000), at(90));
    expect(r).toMatchObject({ state: 'resolved', notified: 'resolved' });
    expect(delivered.slice(n).map((d) => d.payload.title)).toEqual(['Error rate กลับมาปกติ', 'Error rate กลับมาปกติ']);
    expect((await alertRows())[0].resolved_at).not.toBeNull();
    expect((await engineer.agent.post(`/ops/system/alerts/${alertId}/acknowledge`)).status).toBe(409);
    expect((await support.agent.get('/ops/system/alerts')).body.open).toBeNull();
  });

  it('เปิดเหตุขัดข้องอัตโนมัติเมื่อเปิดในค่าตั้ง · อีเมลปิดแล้วไม่ส่ง', async () => {
    await owner.agent.put('/ops/system/alert-settings').send({ thresholdPct: 2, windowMin: 5, minRequests: 200, push: true, email: false, autoIncident: true }).expect(200);
    const n = mail.sent.length;
    const r = await alerts.ingest(snap(500, 5000), at(200));
    expect(r.state).toBe('opened');
    const row = (await alertRows()).at(-1);
    expect(row.incident_id).not.toBeNull();
    expect((await t.owner.query(`SELECT internal, owner_id FROM incidents WHERE id = $1`, [row.incident_id])).rows[0]).toEqual({ internal: true, owner_id: null });
    expect(mail.sent.length).toBe(n);
  });
});

describe('ผลการส่ง Push (S12)', () => {
  it('ส่งไม่ถึงบันทึกไว้กับเครื่อง · หน้าแจ้งเตือนแสดงเครื่องที่ล้มล่าสุด · ส่งได้อีกครั้งหายจากรายการ', async () => {
    failing = new Set(['https://push.example.com/eng-phone']);
    expect((await engineer.agent.post('/ops/push/test').send({})).body).toEqual({ devices: 0 });
    const row = (await t.owner.query(`SELECT last_error, last_error_at, last_ok_at FROM staff_push_subscriptions WHERE endpoint = 'https://push.example.com/eng-phone'`)).rows[0];
    expect(row.last_error).toBe('503: Service Unavailable');
    const st = await engineer.agent.get('/ops/push');
    expect(st.body).toMatchObject({ devices: 1, failing: [{ userAgent: 'Android Chrome (ทดสอบ)', lastError: '503: Service Unavailable' }] });
    failing = new Set();
    expect((await engineer.agent.post('/ops/push/test').send({})).body).toEqual({ devices: 1 });
    expect((await engineer.agent.get('/ops/push')).body.failing).toEqual([]);
    expect((await t.owner.query(`SELECT last_ok_at FROM staff_push_subscriptions WHERE endpoint = 'https://push.example.com/eng-phone'`)).rows[0].last_ok_at).not.toBeNull();
  });
});

describe('อ่านตัวนับจาก API', () => {
  it('อ่านไม่ได้ = ไม่เปลี่ยนสถานะ และบอกเหตุในหน้าสถานะ · อ่านได้ส่ง window ตามค่าตั้ง', async () => {
    const fresh = new AlertsService((alerts as unknown as { db: Db }).db, mail, push);
    fresh.fetchTraffic = async () => {
      throw new Error('HTTP 401');
    };
    expect(await fresh.pull(at(300))).toBeNull();
    expect(fresh.lastError).toBe('HTTP 401');
    const calls: number[] = [];
    fresh.fetchTraffic = async (w) => (calls.push(w), snap(0, 10));
    expect((await fresh.pull(at(301)))!.state).not.toBe('opened');
    expect(calls).toEqual([5]);
  });
});
