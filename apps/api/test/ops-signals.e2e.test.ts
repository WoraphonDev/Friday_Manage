// O43 · ตัวนับ 5xx ของหน้าสถานะระบบ (S10) และการตรวจลายเซ็น SNS ของ bounce / complaint · ข้อมูลสมมติเท่านั้น
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EmailFeedbackService, SnsVerifier, snsStringToSign } from '../src/channels/email-feedback.js';
import { traffic } from '../src/common/errors.js';
import { startApp, type TestApp } from './helpers.js';

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const metrics = (token = 'dev-ops-metrics', window?: number) => http().get(`/api/v1/internal/traffic${window ? `?window=${window}` : ''}`).set('x-ops-metrics-token', token);

beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());

describe('ตัวนับคำขอและ 5xx', () => {
  it('ต้องมี token · นับทุกคำขอ แยก 5xx และเส้นทางที่ล้มแบบ pattern · ไม่นับคำขอของ ops-api เอง', async () => {
    traffic.reset();
    expect((await metrics('wrong-token')).status).toBe(401);
    expect((await http().get('/api/v1/internal/traffic')).status).toBe(401);
    for (let i = 0; i < 3; i++) await http().get('/api/v1/auth/csrf').expect(200);
    await http().get('/api/v1/no-such-route').expect(404);
    const svc = t.app.get(EmailFeedbackService);
    const original = svc.receive.bind(svc);
    svc.receive = async () => {
      throw new Error('จำลองระบบล่ม');
    };
    try {
      await http().post('/api/v1/hooks/email-feedback?token=dev-email-feedback').set('content-type', 'application/json').send({}).expect(500);
      await http().post('/api/v1/hooks/email-feedback?token=dev-email-feedback').set('content-type', 'application/json').send({}).expect(500);
    } finally {
      svc.receive = original;
    }
    const r = await metrics();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ windowMin: 5, total: 6, errors: 2, ratePct: 33.33, topRoute: { route: 'POST /hooks/email-feedback', errors: 2 } });
    expect(r.body.p95Ms).toEqual(expect.any(Number));
    expect(r.body.minutes.at(-1)).toMatchObject({ total: 6, errors: 2, topRoute: 'POST /hooks/email-feedback' });
    // ops-api อ่านซ้ำได้โดยไม่ทำให้ตัวเลขเปลี่ยน
    expect((await metrics(undefined, 10)).body).toMatchObject({ windowMin: 10, total: 6 });
  });

  it('ช่วงเวลา: ช่องที่เก่ากว่า window ไม่นับในอัตรา แต่ยังอยู่ในรายนาที 60 นาที', () => {
    traffic.reset();
    const now = Date.parse('2026-11-16T03:30:20Z');
    traffic.record('GET /x', 500, 10, now - 20 * 60_000);
    traffic.record('GET /x', 200, 10, now - 60_000);
    traffic.record('POST /w/:ws/issues', 503, 30, now);
    const snap = traffic.snapshot(5, now);
    expect(snap).toMatchObject({ total: 2, errors: 1, ratePct: 50, topRoute: { route: 'POST /w/:ws/issues', errors: 1 } });
    expect(snap.minutes).toHaveLength(3);
    traffic.record('GET /x', 200, 10, now + 61 * 60_000);
    expect(traffic.snapshot(5, now + 61 * 60_000).minutes.map((m) => m.total)).toEqual([1]);
  });
});

describe('SNS: ลายเซ็น TopicArn และยืนยันการสมัครอัตโนมัติ', () => {
  const TOPIC = 'arn:aws:sns:ap-southeast-1:123456789012:friday-ses-feedback';
  const CERT = 'https://sns.ap-southeast-1.amazonaws.com/SimpleNotificationService-0000demo.pem';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let verifier: SnsVerifier;
  let certFetches: string[];
  let confirmed: string[];
  let pem: string;
  const env = { ...process.env };

  const signed = (m: Record<string, unknown>, version: '1' | '2' = '2', key: KeyObject = privateKey) => {
    const msg = { SignatureVersion: version, SigningCertURL: CERT, TopicArn: TOPIC, Timestamp: '2026-11-16T03:00:00.000Z', MessageId: 'sns-demo-2', ...m };
    return { ...msg, Signature: sign(version === '1' ? 'RSA-SHA1' : 'RSA-SHA256', Buffer.from(snsStringToSign(msg)), key).toString('base64') };
  };
  const bounce = { notificationType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'ghost@sns-demo.example.com' }] } };
  const post = (body: unknown) => http().post('/api/v1/hooks/email-feedback?token=dev-email-feedback').set('content-type', 'text/plain').send(JSON.stringify(body));

  beforeAll(() => {
    verifier = t.app.get(SnsVerifier);
    pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  });
  afterEach(() => {
    process.env.SNS_VERIFY = env.SNS_VERIFY;
    process.env.SNS_ALLOWED_TOPIC_ARNS = env.SNS_ALLOWED_TOPIC_ARNS;
    if (env.SNS_VERIFY === undefined) delete process.env.SNS_VERIFY;
    if (env.SNS_ALLOWED_TOPIC_ARNS === undefined) delete process.env.SNS_ALLOWED_TOPIC_ARNS;
  });
  const enable = () => {
    process.env.SNS_VERIFY = 'on';
    process.env.SNS_ALLOWED_TOPIC_ARNS = `arn:aws:sns:ap-southeast-1:123456789012:other, ${TOPIC}`;
    certFetches = [];
    confirmed = [];
    verifier.fetchCert = async (url) => (certFetches.push(url), pem);
    verifier.confirm = async (url) => void confirmed.push(url);
  };

  it('ลายเซ็นถูกต้องทั้ง v1 (SHA1) และ v2 (SHA256) · ดึงใบรับรองครั้งเดียวแล้วจำไว้', async () => {
    enable();
    const r1 = await post(signed({ Type: 'Notification', Message: JSON.stringify(bounce) }, '1'));
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body).toEqual({ accepted: 1, suppressed: 1 });
    const r2 = await post(signed({ Type: 'Notification', Subject: 'Amazon SES Email Event Notification', Message: JSON.stringify(bounce) }, '2'));
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(certFetches).toEqual([CERT]);
  });

  it('ลายเซ็นผิด / แก้ข้อความหลังเซ็น / ไม่มีลายเซ็น → ปฏิเสธ และไม่เพิ่มรายชื่อไม่ส่ง', async () => {
    enable();
    await t.owner.query(`DELETE FROM email_suppressions`);
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect((await post(signed({ Type: 'Notification', Message: JSON.stringify(bounce) }, '2', other))).body.error.code).toBe('sns_signature_invalid');
    const tampered = { ...signed({ Type: 'Notification', Message: JSON.stringify(bounce) }), Message: JSON.stringify({ ...bounce, extra: 1 }) };
    expect((await post(tampered)).status).toBe(401);
    expect((await post({ Type: 'Notification', Message: JSON.stringify(bounce), SignatureVersion: '1', SigningCertURL: CERT, TopicArn: TOPIC })).body.error.code).toBe('sns_signature_missing');
    // ส่งตรงแบบไม่มีซอง SNS ใช้ได้เฉพาะตอนปิดตรวจ (ตัวจำลองในเครื่อง)
    expect((await post(bounce)).body.error.code).toBe('sns_required');
    expect((await post(signed({ Type: 'Notification', Message: '{}' }, '3' as '2'))).body.error.code).toBe('sns_signature_version');
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM email_suppressions`)).rows[0].n).toBe(0);
  });

  it('ใบรับรองต้องเป็น https ของ sns.*.amazonaws.com · ไม่ดึงจากที่อื่นเลย', async () => {
    enable();
    for (const url of ['http://sns.ap-southeast-1.amazonaws.com/cert.pem', 'https://sns.ap-southeast-1.amazonaws.com.evil.example/cert.pem', 'https://evil.example/sns.amazonaws.com.pem', 'https://s3.amazonaws.com/cert.pem', 'https://sns.ap-southeast-1.amazonaws.com/cert.txt']) {
      const r = await post(signed({ Type: 'Notification', Message: JSON.stringify(bounce), SigningCertURL: url }));
      expect(r.body.error.code, url).toBe('sns_cert_url');
    }
    expect(certFetches).toEqual([]);
  });

  it('TopicArn ที่ไม่อนุญาต → 403 · ไม่ตั้งรายการเลย = ไม่รับทุก Topic', async () => {
    enable();
    const r = await post(signed({ Type: 'Notification', Message: JSON.stringify(bounce), TopicArn: 'arn:aws:sns:us-east-1:999999999999:someone-else' }));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('sns_topic_not_allowed');
    process.env.SNS_ALLOWED_TOPIC_ARNS = '';
    expect((await post(signed({ Type: 'Notification', Message: JSON.stringify(bounce) }))).status).toBe(403);
  });

  it('SubscriptionConfirmation ที่เซ็นถูกต้อง → เรียก SubscribeURL ให้อัตโนมัติ · URL นอก AWS ไม่เรียก', async () => {
    enable();
    const url = `https://sns.ap-southeast-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC)}&Token=demo-token`;
    const r = await post(signed({ Type: 'SubscriptionConfirmation', Message: 'You have chosen to subscribe', SubscribeURL: url, Token: 'demo-token' }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ accepted: 0, subscription: 'confirmed' });
    expect(confirmed).toEqual([url]);
    const evil = await post(signed({ Type: 'SubscriptionConfirmation', Message: 'x', SubscribeURL: 'https://evil.example/confirm', Token: 'demo-token' }));
    expect(evil.body).toEqual({ accepted: 0, subscription: 'pending' });
    expect(confirmed).toHaveLength(1);
    // ยืนยันไม่สำเร็จ → 502 ให้ SNS ส่งซ้ำ
    verifier.confirm = async () => {
      throw new Error('timeout');
    };
    expect((await post(signed({ Type: 'SubscriptionConfirmation', Message: 'x', SubscribeURL: url, Token: 'demo-token' }))).status).toBe(502);
  });

  it('ปิดตรวจ (dev / test ค่าเริ่มต้น): รับแบบเดิม และไม่ยืนยันการสมัครเอง', async () => {
    delete process.env.SNS_VERIFY;
    confirmed = [];
    const r = await post({ Type: 'SubscriptionConfirmation', SubscribeURL: 'https://sns.ap-southeast-1.amazonaws.com/?Action=ConfirmSubscription' });
    expect(r.body).toEqual({ accepted: 0, subscription: 'pending' });
    expect(confirmed).toEqual([]);
  });

  // ใบรับรอง X.509 จริงแบบที่ AWS ส่ง (สร้างเองด้วย openssl) · เครื่องที่ไม่มี openssl ข้ามข้อนี้
  const hasOpenssl = (() => {
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  it.skipIf(!hasOpenssl)('ตรวจด้วยใบรับรอง X.509 (self-signed จำลอง)', async () => {
    enable();
    const dir = mkdtempSync(join(tmpdir(), 'sns-cert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-subj', '/CN=sns.amazonaws.com', '-days', '1'], { stdio: 'ignore' });
    const certPem = readFileSync(join(dir, 'cert.pem'), 'utf8');
    const keyPem = readFileSync(join(dir, 'key.pem'), 'utf8');
    const certUrl = 'https://sns.ap-southeast-1.amazonaws.com/SimpleNotificationService-x509demo.pem';
    verifier.fetchCert = async () => certPem;
    const { createPrivateKey } = await import('node:crypto');
    const r = await post(signed({ Type: 'Notification', Message: JSON.stringify(bounce), SigningCertURL: certUrl }, '2', createPrivateKey(keyPem)));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });
});
