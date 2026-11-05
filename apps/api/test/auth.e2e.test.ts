// A13 · ยืนยันอีเมล, ลืมรหัสผ่าน, 2FA, Google / Microsoft (provider ปลอมในเครื่อง), Session
// ข้อมูลสมมติทั้งหมด · ไม่เรียก Google / Microsoft จริง
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOTP_STEP, totpAt } from '../src/auth/crypto.js';
import { type Client, client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;

// ---------------------------------------------------------------------------
// OAuth provider ปลอม: token endpoint ตรวจ PKCE (S256), client และ redirect_uri · userinfo ตอบตาม code
// ---------------------------------------------------------------------------
interface FakeGrant {
  challenge: string;
  redirectUri: string;
  clientId: string;
  info: Record<string, unknown>;
}
const grants = new Map<string, FakeGrant>();
const accessTokens = new Map<string, Record<string, unknown>>();
const tokenRequests: Record<string, string>[] = [];
let fake: Server;
let grantNo = 0;

function startFakeProvider() {
  fake = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && url.pathname.endsWith('/token')) {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const p = Object.fromEntries(new URLSearchParams(raw));
        tokenRequests.push(p);
        const g = grants.get(p.code);
        grants.delete(p.code);
        const pkceOk = g && createHash('sha256').update(p.code_verifier ?? '').digest('base64url') === g.challenge;
        const secret = url.pathname.startsWith('/google') ? 'fake-google-secret' : 'fake-microsoft-secret';
        if (!g || !pkceOk || p.grant_type !== 'authorization_code' || p.client_id !== g.clientId || p.client_secret !== secret || p.redirect_uri !== g.redirectUri) {
          return json(400, { error: 'invalid_grant' });
        }
        const at = randomBytes(12).toString('hex');
        accessTokens.set(at, g.info);
        json(200, { access_token: at, token_type: 'Bearer', expires_in: 3600 });
      });
      return;
    }
    if (req.method === 'GET' && url.pathname.endsWith('/userinfo')) {
      const info = accessTokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      return info ? json(200, info) : json(401, { error: 'invalid_token' });
    }
    json(404, { error: 'not_found' });
  });
  return new Promise<string>((resolve) => fake.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(fake.address() as AddressInfo).port}`)));
}

/** เดินครบ start → provider → callback · คืน Location ของ start และของ callback */
async function oauth(c: Client, provider: 'google' | 'microsoft', info: Record<string, unknown>, query = '') {
  const start = await c.get(`/auth/oauth/${provider}/start${query}`);
  expect(start.status).toBe(302);
  const auth = new URL(start.headers.location);
  const code = `code-${++grantNo}`;
  grants.set(code, {
    challenge: auth.searchParams.get('code_challenge')!,
    redirectUri: auth.searchParams.get('redirect_uri')!,
    clientId: auth.searchParams.get('client_id')!,
    info,
  });
  const cb = await c.get(`/auth/oauth/${provider}/callback?code=${code}&state=${auth.searchParams.get('state')}`);
  expect(cb.status).toBe(302);
  return { authorize: auth, location: new URL(cb.headers.location) };
}

/** รหัส TOTP ของ step ปัจจุบัน + offset (ใช้ step ที่เพิ่มขึ้นเรื่อย ๆ เพราะระบบห้ามใช้ step เดิมซ้ำ) */
const totp = (secret: string, offset = 0) => totpAt(secret, Math.floor(Date.now() / 1000 / TOTP_STEP) + offset);

const audits = async (action: string) =>
  (await t.owner.query('SELECT summary, actor_id, target_id FROM audit_logs WHERE category = $1 AND action = $2 ORDER BY created_at', ['secu', action])).rows;

beforeAll(async () => {
  const base = await startFakeProvider();
  Object.assign(process.env, {
    WEB_URL: 'http://web.example.test',
    API_PUBLIC_URL: 'http://api.example.test',
    OAUTH_GOOGLE_CLIENT_ID: 'fake-google-client',
    OAUTH_GOOGLE_CLIENT_SECRET: 'fake-google-secret',
    OAUTH_GOOGLE_AUTHORIZE_URL: `${base}/google/authorize`,
    OAUTH_GOOGLE_TOKEN_URL: `${base}/google/token`,
    OAUTH_GOOGLE_USERINFO_URL: `${base}/google/userinfo`,
    OAUTH_MICROSOFT_CLIENT_ID: 'fake-microsoft-client',
    OAUTH_MICROSOFT_CLIENT_SECRET: 'fake-microsoft-secret',
    OAUTH_MICROSOFT_AUTHORIZE_URL: `${base}/microsoft/authorize`,
    OAUTH_MICROSOFT_TOKEN_URL: `${base}/microsoft/token`,
    OAUTH_MICROSOFT_USERINFO_URL: `${base}/microsoft/userinfo`,
  });
  t = await startApp();
  team = await seedTeam(t);
});
afterAll(async () => {
  await t.close();
  await new Promise((r) => fake.close(r));
});

describe('ยืนยันอีเมล (J2)', () => {
  it('สมัครแล้วได้รหัส 6 หลัก + ลิงก์ · ส่งใหม่ได้ทุก 60 วินาที · ผิด 5 ครั้งรหัสใช้ไม่ได้', async () => {
    const c = await client(t.app);
    const r = await c.post('/auth/signup', { email: 'ploy@example.com', password: 'Friday2026', displayName: 'Ploy', acceptTerms: true });
    expect(r.status).toBe(201);
    const code = r.headers['x-dev-token'];
    const link = r.headers['x-dev-link-token'];
    expect(code).toMatch(/^\d{6}$/);
    expect(link.length).toBeGreaterThan(20);
    // เก็บเป็น hash เท่านั้น
    const stored = (await t.owner.query(`SELECT token_hash FROM auth_tokens WHERE purpose = 'verify_email' AND user_id = $1`, [r.body.id])).rows;
    expect(stored).toHaveLength(2);
    expect(stored.map((x) => x.token_hash)).not.toContain(code);

    const tooSoon = await c.post('/auth/verify-email:resend', {});
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.error.code).toBe('resend_too_soon');
    expect(tooSoon.body.error.details.retryAfter).toBeGreaterThan(50);

    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const bad = await c.post('/auth/verify-email', { code: wrong });
      expect(bad.body.error.code).toBe('invalid_token');
    }
    // ผิดครบ 5 ครั้ง รหัสเดิมและลิงก์เดิมถูกยกเลิก
    expect((await c.post('/auth/verify-email', { code })).body.error.code).toBe('invalid_token');
    expect((await c.post('/auth/verify-email', { token: link })).body.error.code).toBe('invalid_token');

    // ผ่านไป 60 วินาที → ขอใหม่ได้
    await t.owner.query(`UPDATE auth_tokens SET created_at = now() - interval '2 minutes' WHERE user_id = $1`, [r.body.id]);
    const again = await c.post('/auth/verify-email:resend', {});
    expect(again.status).toBe(202);
    const ok = await c.post('/auth/verify-email', { email: 'PLOY@example.com', code: again.headers['x-dev-token'] });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ emailVerified: true, email: 'ploy@example.com' });
    expect((await c.get('/me')).body.emailVerified).toBe(true);
    // ใช้ซ้ำไม่ได้
    expect((await c.post('/auth/verify-email', { code: again.headers['x-dev-token'] })).status).toBe(400);
  });

  it('กดลิงก์ในอีเมลจากเครื่องอื่นได้ (ไม่ต้องล็อกอิน) · resend ของอีเมลที่ไม่มีบัญชีตอบ 202 เหมือนกัน', async () => {
    const c = await client(t.app);
    const r = await c.post('/auth/signup', { email: 'beam@example.com', password: 'Friday2026', displayName: 'Beam', acceptTerms: true });
    const anon = await client(t.app);
    const ok = await anon.post('/auth/verify-email', { token: r.headers['x-dev-link-token'] });
    expect(ok.status).toBe(200);
    expect((await c.get('/me')).body.emailVerified).toBe(true);

    const ghost = await anon.post('/auth/verify-email:resend', { email: 'nobody@example.com' });
    expect(ghost.status).toBe(202);
    expect(ghost.headers['x-dev-token']).toBeUndefined();
  });
});

describe('ลืมรหัสผ่าน (J3)', () => {
  it('forgot ตอบ 202 เสมอ · ขอซ้ำภายใน 60 วินาทีไม่ส่งใหม่', async () => {
    const anon = await client(t.app);
    const none = await anon.post('/auth/password/forgot', { email: 'nobody@example.com' });
    expect(none.status).toBe(202);
    expect(none.headers['x-dev-token']).toBeUndefined();

    const first = await anon.post('/auth/password/forgot', { email: 'dev@friday-dev.example.com' });
    expect(first.status).toBe(202);
    expect(first.body).toEqual(none.body);
    expect(first.headers['x-dev-token']).toBeTruthy();
    const second = await anon.post('/auth/password/forgot', { email: 'dev@friday-dev.example.com' });
    expect(second.status).toBe(202);
    expect(second.headers['x-dev-token']).toBeUndefined();
  });

  it('reset ตามนโยบายของ Workspace · ออกจากระบบทุกเครื่อง · ลิงก์ใช้ได้ครั้งเดียว', async () => {
    await t.owner.query(`UPDATE auth_tokens SET created_at = now() - interval '2 minutes' WHERE purpose = 'reset_password'`);
    const anon = await client(t.app);
    const r = await anon.post('/auth/password/forgot', { email: 'dev@friday-dev.example.com' });
    const token = r.headers['x-dev-token'];

    const info = await anon.get(`/auth/password/reset?token=${token}`);
    expect(info.body).toMatchObject({ email: 'dev@friday-dev.example.com', policy: { minLength: 10, requireSpecial: true } });

    // security_policies ค่าเริ่มต้น: อย่างน้อย 10 ตัว + อักขระพิเศษ
    const weak = await anon.post('/auth/password/reset', { token, newPassword: 'Friday2027' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.details.fields[0]).toMatchObject({ path: 'newPassword', message: 'ต้องมีอักขระพิเศษ' });

    expect((await team.dev.get('/me')).status).toBe(200);
    const ok = await anon.post('/auth/password/reset', { token, newPassword: 'Friday-2027!', logoutAll: true });
    expect(ok.status).toBe(200);
    expect(ok.body.loggedOutSessions).toBeGreaterThanOrEqual(1);
    expect((await team.dev.get('/me')).status).toBe(401);
    expect((await anon.post('/auth/password/reset', { token, newPassword: 'Friday-2028!' })).body.error.code).toBe('invalid_token');

    expect((await anon.post('/auth/login', { email: 'dev@friday-dev.example.com', password: 'Friday2026' })).status).toBe(401);
    expect((await anon.post('/auth/login', { email: 'dev@friday-dev.example.com', password: 'Friday-2027!' })).status).toBe(200);
    expect(await audits('secu.password_reset')).toHaveLength(1);
    team.dev = anon;
  });

  it('x-dev-token มีเฉพาะ NODE_ENV=test', async () => {
    await t.owner.query(`UPDATE auth_tokens SET created_at = now() - interval '2 minutes' WHERE purpose = 'reset_password'`);
    const anon = await client(t.app);
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const r = await anon.post('/auth/password/forgot', { email: 'dev@friday-dev.example.com' });
      expect(r.status).toBe(202);
      expect(r.headers['x-dev-token']).toBeUndefined();
    } finally {
      process.env.NODE_ENV = env;
    }
  });
});

describe('ล็อกบัญชีตาม security_policies', () => {
  it('ใช้ค่าที่เข้มที่สุดของ Workspace ที่อยู่ · Audit secu.login_failed', async () => {
    await t.owner.query(`UPDATE security_policies SET lockout_attempts = 3, lockout_minutes = 20`);
    const c = await client(t.app);
    const login = (password: string) => c.post('/auth/login', { email: 'lead@friday-dev.example.com', password });
    const r1 = await login('wrong');
    expect(r1.body.error.details).toEqual({ attemptsLeft: 2, lockoutMinutes: 20 });
    await login('wrong');
    const r3 = await login('wrong');
    expect(r3.body.error.details.attemptsLeft).toBe(0);
    const locked = await login('Friday2026');
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('account_locked');
    const failed = (await audits('secu.login_failed')).filter((a) => a.target_id === team.leadId);
    expect(failed).toHaveLength(3);
    expect(failed[2].summary).toContain('ล็อกบัญชี 20 นาที');

    await t.owner.query(`UPDATE users SET locked_until = NULL, failed_login_count = 0`);
    await t.owner.query(`UPDATE security_policies SET lockout_attempts = 5, lockout_minutes = 15`);
    expect((await login('Friday2026')).status).toBe(200);
  });
});

describe('2FA (J1 ขั้นที่ 2 และ Profile)', () => {
  let secret: string;
  let backupCodes: string[];

  it('setup → enable ด้วยรหัสแรกจากแอป · ได้ Backup code 10 รหัส · secret เก็บแบบเข้ารหัส', async () => {
    const { lead, leadId } = team;
    expect((await lead.get('/me/mfa')).body).toMatchObject({ enabled: false, setupPending: false, requiredByPolicy: false });
    const s = await lead.post('/me/mfa:setup');
    expect(s.status).toBe(200);
    secret = s.body.secret;
    expect(s.body.otpauthUrl).toContain(`secret=${secret}`);
    expect(s.body.otpauthUrl).toContain('Friday%20Manage');
    const row = (await t.owner.query('SELECT secret_enc FROM mfa_factors WHERE user_id = $1', [leadId])).rows[0];
    expect(row.secret_enc).not.toContain(secret);

    expect((await lead.post('/me/mfa:enable', { code: '000000' })).body.error.code).toBe('invalid_mfa_code');
    const e = await lead.post('/me/mfa:enable', { code: totp(secret, -1) });
    expect(e.status).toBe(200);
    backupCodes = e.body.backupCodes;
    expect(backupCodes).toHaveLength(10);
    expect(backupCodes[0]).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    const stored = (await t.owner.query('SELECT backup_codes_hash FROM mfa_factors WHERE user_id = $1', [leadId])).rows[0].backup_codes_hash;
    expect(stored).toHaveLength(10);
    expect(stored).not.toContain(backupCodes[0]);

    expect((await lead.post('/me/mfa:setup')).body.error.code).toBe('mfa_already_enabled');
    expect((await lead.get('/me/mfa')).body).toMatchObject({ enabled: true, backupCodesLeft: 10 });
    expect(await audits('secu.mfa_enabled')).toHaveLength(1);
  });

  it('Login ได้ mfaToken แทน Session · รหัสผิดนับรวมกับการล็อก · trustDevice ไม่ถามอีกบนอุปกรณ์เดิม', async () => {
    const c = await client(t.app);
    const r = await c.post('/auth/login', { email: 'lead@friday-dev.example.com', password: 'Friday2026' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mfaRequired: true, email: 'lead@friday-dev.example.com' });
    expect((await c.get('/me')).status).toBe(401);

    const bad = await c.post('/auth/login/mfa', { mfaToken: r.body.mfaToken, code: '123456' });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toMatchObject({ code: 'invalid_mfa_code', details: { attemptsLeft: 4 } });
    const forged = await c.post('/auth/login/mfa', { mfaToken: `${r.body.mfaToken}x`, code: totp(secret) });
    expect(forged.body.error.code).toBe('mfa_token_invalid');

    const ok = await c.post('/auth/login/mfa', { mfaToken: r.body.mfaToken, code: totp(secret), trustDevice: true });
    expect(ok.status).toBe(200);
    expect(String(ok.headers['set-cookie'])).toContain('fm_mfa_trust=');
    expect((await c.get('/me')).status).toBe(200);
    // รหัสเดิมใช้ซ้ำไม่ได้ (กันดักรหัส)
    const replay = await (await client(t.app)).post('/auth/login/mfa', { mfaToken: r.body.mfaToken, code: totp(secret) });
    expect(replay.status).toBe(401);

    // ออกจากระบบแล้วเข้าใหม่บนอุปกรณ์เดิม → ไม่ถาม 2FA
    expect((await c.post('/auth/logout')).status).toBe(204);
    const again = await c.post('/auth/login', { email: 'lead@friday-dev.example.com', password: 'Friday2026' });
    expect(again.body).toEqual({ id: team.leadId });
    const sessions = (await c.get('/me/sessions')).body.items;
    const current = sessions.find((s: { current: boolean }) => s.current);
    expect(new Date(current.mfaTrustedUntil).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    // ออกจากระบบเครื่องนี้จากหน้า Profile = เลิกจำอุปกรณ์ด้วย
    expect((await c.delete(`/me/sessions/${current.id}`)).status).toBe(204);
    const third = await c.post('/auth/login', { email: 'lead@friday-dev.example.com', password: 'Friday2026' });
    expect(third.body.mfaRequired).toBe(true);
  });

  it('Backup code ใช้ได้ครั้งเดียว', async () => {
    const c = await client(t.app);
    const r = await c.post('/auth/login', { email: 'lead@friday-dev.example.com', password: 'Friday2026' });
    const ok = await c.post('/auth/login/mfa', { mfaToken: r.body.mfaToken, code: backupCodes[0].toUpperCase() });
    expect(ok.status).toBe(200);
    expect(ok.body.backupCodesLeft).toBe(9);
    const c2 = await client(t.app);
    const r2 = await c2.post('/auth/login', { email: 'lead@friday-dev.example.com', password: 'Friday2026' });
    expect((await c2.post('/auth/login/mfa', { mfaToken: r2.body.mfaToken, code: backupCodes[0] })).status).toBe(401);
    expect(await audits('secu.backup_code_used')).toHaveLength(1);
  });

  it('ออก Backup code ใหม่แล้วชุดเดิมใช้ไม่ได้ · ปิดไม่ได้ถ้า Workspace บังคับ', async () => {
    const { lead } = team;
    const regen = await lead.post('/me/mfa/backup-codes:regenerate', { code: totp(secret, 1) });
    expect(regen.status).toBe(200);
    const fresh: string[] = regen.body.backupCodes;
    expect(fresh).toHaveLength(10);

    await t.owner.query(`UPDATE security_policies SET mfa_enforcement = 'admin'`);
    expect((await lead.get('/me/mfa')).body.requiredByPolicy).toBe(true);
    const blocked = await lead.post('/me/mfa:disable', { code: fresh[0] });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('mfa_required_by_policy');
    // Member ไม่โดนนโยบาย admin
    expect((await team.dev.get('/me/mfa')).body.requiredByPolicy).toBe(false);
    await t.owner.query(`UPDATE security_policies SET mfa_enforcement = 'none'`);

    expect((await lead.post('/me/mfa:disable', { code: backupCodes[1] })).body.error.code).toBe('invalid_mfa_code');
    const off = await lead.post('/me/mfa:disable', { code: fresh[0] });
    expect(off.status).toBe(200);
    expect((await lead.get('/me/mfa')).body.enabled).toBe(false);
    const c = await client(t.app);
    expect((await c.post('/auth/login', { email: 'lead@friday-dev.example.com', password: 'Friday2026' })).body).toEqual({ id: team.leadId });
    expect(await audits('secu.mfa_disabled')).toHaveLength(1);
  });
});

describe('Session (Profile › อุปกรณ์ที่ล็อกอินอยู่)', () => {
  it('ดูรายการ · ออกจากระบบรายเครื่อง · ออกจากเครื่องอื่นทั้งหมด', async () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
    const mac = await client(t.app);
    const csrf = (await mac.get('/auth/csrf')).body.csrfToken;
    const macLogin = await mac.agent.post('/api/v1/auth/login').set('user-agent', ua).set('x-csrf-token', csrf).send({ email: 'lead@friday-dev.example.com', password: 'Friday2026' });
    expect(macLogin.status).toBe(200);
    const phone = await client(t.app);
    await phone.post('/auth/login', { email: 'lead@friday-dev.example.com', password: 'Friday2026' });

    const list = await team.lead.get('/me/sessions');
    expect(list.status).toBe(200);
    const items = list.body.items as { id: string; current: boolean; deviceName: string | null }[];
    expect(items.filter((s) => s.current)).toHaveLength(1);
    expect(items.map((s) => s.deviceName)).toContain('Chrome · macOS');

    const macSession = items.find((s) => s.deviceName === 'Chrome · macOS')!;
    expect((await team.lead.delete(`/me/sessions/${macSession.id}`)).status).toBe(204);
    expect((await mac.get('/me')).status).toBe(401);
    expect((await team.lead.delete(`/me/sessions/${macSession.id}`)).status).toBe(404);
    // Session ของคนอื่นลบไม่ได้ (RLS) → 404
    const devSession = (await team.dev.get('/me/sessions')).body.items[0].id;
    expect((await team.lead.delete(`/me/sessions/${devSession}`)).status).toBe(404);

    const all = await team.lead.delete('/me/sessions');
    expect(all.body.revoked).toBeGreaterThanOrEqual(1);
    expect((await phone.get('/me')).status).toBe(401);
    expect((await team.lead.get('/me')).status).toBe(200);
    expect((await team.dev.get('/me')).status).toBe(200);
  });

  it('เวลาว่างของ Session ตาม security_policies · CSRF ยังบังคับเหมือนเดิม', async () => {
    const c = await client(t.app);
    await c.post('/auth/login', { email: 'dev@friday-dev.example.com', password: 'Friday-2027!' });
    const id = (await c.get('/me/sessions')).body.items.find((s: { current: boolean }) => s.current).id;
    await t.owner.query(`UPDATE user_sessions SET last_seen_at = now() - interval '3 hours' WHERE id = $1`, [id]);
    expect((await c.get('/me')).status).toBe(200);
    await t.owner.query(`UPDATE security_policies SET session_idle_hours = 2`);
    await t.owner.query(`UPDATE user_sessions SET last_seen_at = now() - interval '3 hours' WHERE id = $1`, [id]);
    expect((await c.get('/me')).status).toBe(401);
    await t.owner.query(`UPDATE security_policies SET session_idle_hours = 8`);

    const noCsrf = await request(t.app.getHttpServer()).post('/api/v1/auth/login').send({ email: 'dev@friday-dev.example.com', password: 'Friday-2027!' });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('csrf_failed');
  });
});

describe('เปลี่ยนรหัสผ่านและอีเมล', () => {
  it('password:change ต้องใส่รหัสเดิม · ตามนโยบาย · ออกจากเครื่องอื่น · Audit', async () => {
    const { lead } = team;
    const other = await client(t.app);
    await other.post('/auth/login', { email: 'lead@friday-dev.example.com', password: 'Friday2026' });

    expect((await lead.post('/me/password:change', { currentPassword: 'nope', newPassword: 'Friday-2027!' })).body.error.code).toBe('wrong_password');
    const weak = await lead.post('/me/password:change', { currentPassword: 'Friday2026', newPassword: 'Short1!' });
    expect(weak.body.error.details.fields[0].message).toBe('อย่างน้อย 10 ตัวอักษร');
    const ok = await lead.post('/me/password:change', { currentPassword: 'Friday2026', newPassword: 'Friday-2027!' });
    expect(ok.status).toBe(200);
    expect(ok.body.loggedOutSessions).toBe(1);
    expect((await other.get('/me')).status).toBe(401);
    expect((await lead.get('/me')).status).toBe(200);
    const a = await audits('secu.password_changed');
    expect(a).toHaveLength(1);
    expect(a[0].actor_id).toBe(team.leadId);
  });

  it('email:change ยืนยันอีเมลใหม่ก่อนเปลี่ยน (รหัส 6 หลักหรือลิงก์)', async () => {
    const { lead } = team;
    expect((await lead.post('/me/email:change', { newEmail: 'mick@friday-dev.example.com', password: 'wrong' })).body.error.code).toBe('wrong_password');
    expect((await lead.post('/me/email:change', { newEmail: 'dev@friday-dev.example.com', password: 'Friday-2027!' })).body.error.code).toBe('email_taken');
    const r = await lead.post('/me/email:change', { newEmail: 'Mick@Friday-dev.example.com', password: 'Friday-2027!' });
    expect(r.status).toBe(202);
    expect(r.body.pendingEmail).toBe('mick@friday-dev.example.com');
    // ยังไม่เปลี่ยนจนกว่าจะยืนยัน
    expect((await lead.get('/me')).body.email).toBe('lead@friday-dev.example.com');
    const ok = await lead.post('/me/email:confirm', { code: r.headers['x-dev-token'] });
    expect(ok.status).toBe(200);
    expect((await lead.get('/me')).body).toMatchObject({ email: 'mick@friday-dev.example.com', emailVerified: true });
    const c = await client(t.app);
    expect((await c.post('/auth/login', { email: 'mick@friday-dev.example.com', password: 'Friday-2027!' })).status).toBe(200);
    expect(await audits('secu.email_changed')).toHaveLength(1);

    // ลิงก์ในอีเมลใหม่ กดจากที่ไหนก็ได้
    const dev = team.dev;
    const r2 = await dev.post('/me/email:change', { newEmail: 'kaijeaw@friday-dev.example.com', password: 'Friday-2027!' });
    const anon = await client(t.app);
    const linked = await anon.post('/auth/verify-email', { token: r2.headers['x-dev-link-token'] });
    expect(linked.body).toMatchObject({ emailVerified: true, email: 'kaijeaw@friday-dev.example.com' });
    expect((await dev.get('/me')).body.email).toBe('kaijeaw@friday-dev.example.com');
  });
});

describe('Google / Microsoft (OAuth + PKCE กับ provider ปลอม)', () => {
  it('start ส่งไป provider พร้อม PKCE S256 · สมัครบัญชีใหม่ให้ถ้ายังไม่มี', async () => {
    const c = await client(t.app);
    const { authorize, location } = await oauth(c, 'google', { sub: 'g-1001', email: 'Nok@Example.com', email_verified: true, name: 'Nok' }, '?next=/w/friday-dev&remember=true');
    expect(authorize.origin + authorize.pathname).toBe(`${process.env.OAUTH_GOOGLE_AUTHORIZE_URL}`);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toBe('http://api.example.test/api/v1/auth/oauth/google/callback');
    expect(tokenRequests.at(-1)?.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(location.toString()).toBe('http://web.example.test/w/friday-dev');

    const me = await c.get('/me');
    expect(me.body).toMatchObject({ email: 'nok@example.com', displayName: 'Nok', emailVerified: true });
    const ids = (await c.get('/me/identities')).body.items;
    expect(ids).toMatchObject([{ provider: 'google', canDelete: false }]);
    const last = await c.delete(`/me/identities/${ids[0].id}`);
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe('last_login_method');

    // เข้าครั้งถัดไปด้วย sub เดิม = บัญชีเดิม (แม้ provider เปลี่ยนอีเมล)
    const c2 = await client(t.app);
    await oauth(c2, 'google', { sub: 'g-1001', email: 'nok.new@example.com', email_verified: true });
    expect((await c2.get('/me')).body.id).toBe(me.body.id);
  });

  it('อีเมลตรงบัญชีเดิม → ผูก user_identities เพิ่ม · ถ้าเปิด 2FA ต้องผ่าน 2FA ก่อน', async () => {
    const c = await client(t.app);
    const { location } = await oauth(c, 'microsoft', { sub: 'ms-2002', email: 'kaijeaw@friday-dev.example.com', name: 'Kaijeaw' });
    expect(location.toString()).toBe('http://web.example.test/');
    expect((await c.get('/me')).body.id).toBe(team.devId);
    const providers = (await c.get('/me/identities')).body.items.map((x: { provider: string }) => x.provider);
    expect(providers.sort()).toEqual(['microsoft', 'password']);
    expect((await audits('secu.identity_linked')).length).toBeGreaterThanOrEqual(1);

    // Lead เปิด 2FA → OAuth ได้ mfaToken ใน fragment แทน Session
    const s = await team.lead.post('/me/mfa:setup');
    expect((await team.lead.post('/me/mfa:enable', { code: totp(s.body.secret, -1) })).status).toBe(200);
    const c2 = await client(t.app);
    const r = await oauth(c2, 'google', { sub: 'g-3003', email: 'mick@friday-dev.example.com', email_verified: true });
    expect(r.location.pathname).toBe('/login');
    const frag = new URLSearchParams(r.location.hash.slice(1));
    expect(frag.get('email')).toBe('mick@friday-dev.example.com');
    expect((await c2.get('/me')).status).toBe(401);
    const ok = await c2.post('/auth/login/mfa', { mfaToken: frag.get('mfaToken'), code: totp(s.body.secret, 1) });
    expect(ok.status).toBe(200);
    expect((await c2.get('/me')).body.id).toBe(team.leadId);
  });

  it('อีเมลที่ provider บอกว่ายังไม่ยืนยัน ไม่ผูกกับบัญชีเดิม · state ไม่ตรง → error', async () => {
    const c = await client(t.app);
    const { location } = await oauth(c, 'google', { sub: 'g-evil', email: 'kaijeaw@friday-dev.example.com', email_verified: false });
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBe('oauth_email_unverified');
    expect((await c.get('/me')).status).toBe(401);

    const start = await c.get('/auth/oauth/google/start');
    expect(start.status).toBe(302);
    const bad = await c.get('/auth/oauth/google/callback?code=x&state=not-the-state');
    expect(new URL(bad.headers.location).searchParams.get('error')).toBe('oauth_state_mismatch');

    expect((await c.get('/auth/oauth/github/start')).status).toBe(404);
    // ไม่มี redirect ออกนอกเว็บ
    const evil = await c.get('/auth/oauth/google/start?next=//evil.example.com');
    const cb = await oauth(c, 'google', { sub: 'g-1001', email: 'nok@example.com', email_verified: true }, '?next=//evil.example.com');
    expect(evil.status).toBe(302);
    expect(cb.location.toString()).toBe('http://web.example.test/');
  });

  it('ผูกเพิ่มจากหน้า Profile (mode=link) · ลบได้จนเหลือวิธีสุดท้าย', async () => {
    const dev = team.dev;
    const { location } = await oauth(dev, 'google', { sub: 'g-4004', email: 'kaijeaw.personal@example.com', email_verified: true }, '?mode=link&next=/w/friday-dev/profile');
    expect(location.pathname).toBe('/w/friday-dev/profile');
    expect(location.searchParams.get('linked')).toBe('google');

    // บัญชี Google ที่ผูกกับคนอื่นแล้ว ผูกซ้ำไม่ได้
    const taken = await oauth(dev, 'google', { sub: 'g-1001', email: 'nok@example.com', email_verified: true }, '?mode=link&next=/w/friday-dev/profile');
    expect(taken.location.searchParams.get('error')).toBe('identity_in_use');
    expect((await request(t.app.getHttpServer()).get('/api/v1/auth/oauth/google/start?mode=link')).status).toBe(401);

    const ids = (await dev.get('/me/identities')).body.items as { id: string; provider: string; canDelete: boolean }[];
    expect(ids.map((x) => x.provider).sort()).toEqual(['google', 'microsoft', 'password']);
    expect(ids.find((x) => x.provider === 'password')).toHaveProperty('passwordChangedAt');

    // ลบรหัสผ่าน → ล็อกอินด้วยรหัสผ่านไม่ได้อีก
    expect((await dev.delete(`/me/identities/${ids.find((x) => x.provider === 'password')!.id}`)).status).toBe(204);
    const c = await client(t.app);
    expect((await c.post('/auth/login', { email: 'kaijeaw@friday-dev.example.com', password: 'Friday-2027!' })).status).toBe(401);
    expect((await dev.delete(`/me/identities/${ids.find((x) => x.provider === 'google')!.id}`)).status).toBe(204);
    const lastOne = ids.find((x) => x.provider === 'microsoft')!.id;
    expect((await dev.delete(`/me/identities/${lastOne}`)).body.error.code).toBe('last_login_method');
    expect(await audits('secu.identity_unlinked')).toHaveLength(2);

    // บัญชีที่ไม่มีรหัสผ่าน ตั้งรหัสผ่านได้โดยไม่ต้องใส่รหัสเดิม
    const set = await dev.post('/me/password:change', { newPassword: 'Friday-2029!', logoutOthers: false });
    expect(set.status).toBe(200);
    expect((await c.post('/auth/login', { email: 'kaijeaw@friday-dev.example.com', password: 'Friday-2029!' })).status).toBe(200);
  });
});

describe('ผู้ใช้ที่ยังไม่มี Workspace', () => {
  it('ใช้กติการหัสผ่านพื้นฐาน (J2) และไม่มี Audit', async () => {
    const c = await client(t.app);
    await signup(c, 'solo@example.com', 'Solo');
    const ok = await c.post('/me/password:change', { currentPassword: 'Friday2026', newPassword: 'Friday2027' });
    expect(ok.status).toBe(200);
  });
});
