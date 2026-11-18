import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { staffAudit } from '../audit.js';
import { config } from '../config.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { REAUTH_PURPOSE, REAUTH_SECONDS, SESSION_PURPOSE, type Staff } from './auth.guard.js';
import { decryptSecret, encryptSecret, hashPassword, LOCK_ATTEMPTS, LOCK_MINUTES, newTotpSecret, otpauthUrl, PASSWORD_MIN, verifyPassword, verifyTotp } from './password.js';
import { sign, verify } from './tokens.js';

const s = schema;
const CHALLENGE_TTL = 300;

export interface StoredCredential {
  id: string;
  /** base64url ของ COSE public key */
  publicKey: string;
  counter: number;
  transports?: string[];
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}

export const EnrollBody = z.object({ enrollToken: z.string().min(10).optional(), name: z.string().trim().min(1).max(60).default('Security key') });
export const VerifyBody = z.object({ challengeToken: z.string().min(10), response: z.record(z.string(), z.unknown()), name: z.string().trim().min(1).max(60).optional() });
export const LoginOptionsBody = z.object({ email: z.email() });
export const PasswordLoginBody = z.object({ email: z.email(), password: z.string().min(1).max(200) });
const Code = z.string().trim().regex(/^\d{6}$/, 'รหัสต้องเป็นตัวเลข 6 หลัก');
export const TotpLoginBody = z.object({ mfaToken: z.string().min(10), code: Code });
export const TotpBody = z.object({ code: Code });
export const PasswordSetupBody = z.object({ enrollToken: z.string().min(10).optional() });
export const PasswordVerifyBody = z.object({ setupToken: z.string().min(10), password: z.string().min(PASSWORD_MIN, `รหัสผ่านต้องยาวอย่างน้อย ${PASSWORD_MIN} ตัว`).max(200), code: Code });

/** โทเค็นลงทะเบียนครั้งแรก (ออกโดยสคริปต์ `pnpm --filter @friday/ops-api enroll <email>` ใช้ได้ 1 ชั่วโมง) */
export const signEnrollToken = (staffId: string) => sign('ops-enroll', { sid: staffId }, 3600);

type StaffRow = typeof s.staffUsers.$inferSelect;

/** บัญชีใช้งานได้เมื่อมีรหัสผ่าน + TOTP หรือมีกุญแจ 2 อัน (กันล็อกตัวเองออกเมื่อกุญแจหาย · S2) */
const ready = (row: { totpEnabledAt: Date | null }, keys: number) => !!row.totpEnabledAt || keys >= 2;

/**
 * เข้าระบบของพนักงาน Friday · วิธีหลักคือรหัสผ่าน + รหัส 6 หลักจากแอป Authenticator (ใช้ได้ทุกเครื่อง)
 * Security key / Passkey (WebAuthn) เป็นทางเลือก เพราะผูกกับเบราว์เซอร์ จึงใช้ในเครื่องอื่นหรือโหมดไม่ระบุตัวตนไม่ได้
 */
@Injectable()
export class AuthService {
  constructor(@Inject(OPS_DB) private readonly db: Db) {}

  private async staff(id: string) {
    const [row] = await this.db.select().from(s.staffUsers).where(eq(s.staffUsers.id, id));
    return row;
  }
  private creds(row: { webauthnCredentials: unknown }) {
    return (row.webauthnCredentials ?? []) as StoredCredential[];
  }

  /** เริ่มลงทะเบียน key: ใช้ enrollToken (พนักงานใหม่) หรือล็อกอินอยู่แล้ว (เพิ่ม key สำรอง) */
  async registerOptions(sessionStaffId: string | undefined, enrollToken: string | undefined) {
    const sid = sessionStaffId ?? verify<{ sid: string }>('ops-enroll', enrollToken)?.sid;
    if (!sid) throw new AppError(401, 'enroll_token_invalid', 'โทเค็นลงทะเบียนไม่ถูกต้องหรือหมดอายุ');
    const row = await this.staff(sid);
    if (!row) throw new AppError(404, 'not_found', 'ไม่พบพนักงาน');
    const options = await generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpId,
      userName: row.email,
      userDisplayName: row.name,
      userID: new TextEncoder().encode(row.id),
      attestationType: 'none',
      excludeCredentials: this.creds(row).map((c) => ({ id: c.id, transports: c.transports as never })),
      authenticatorSelection: { residentKey: 'discouraged', userVerification: 'preferred' },
    });
    return { options, challengeToken: sign('ops-reg', { sid, challenge: options.challenge }, CHALLENGE_TTL) };
  }

  async registerVerify(body: z.infer<typeof VerifyBody>) {
    const ch = verify<{ sid: string; challenge: string }>('ops-reg', body.challengeToken);
    if (!ch) throw new AppError(400, 'challenge_invalid', 'Challenge หมดอายุหรือไม่ถูกต้อง · เริ่มใหม่');
    const row = await this.staff(ch.sid);
    if (!row) throw new AppError(404, 'not_found', 'ไม่พบพนักงาน');
    let v;
    try {
      v = await verifyRegistrationResponse({ response: body.response as unknown as RegistrationResponseJSON, expectedChallenge: ch.challenge, expectedOrigin: config.origin, expectedRPID: config.rpId, requireUserVerification: false });
    } catch (e) {
      throw new AppError(400, 'registration_failed', `ลงทะเบียน Security key ไม่สำเร็จ: ${(e as Error).message}`);
    }
    if (!v.verified || !v.registrationInfo) throw new AppError(400, 'registration_failed', 'ลงทะเบียน Security key ไม่สำเร็จ');
    const c = v.registrationInfo.credential;
    const next: StoredCredential = { id: c.id, publicKey: Buffer.from(c.publicKey).toString('base64url'), counter: c.counter, transports: c.transports, name: body.name ?? 'Security key', createdAt: new Date().toISOString() };
    if (this.creds(row).some((x) => x.id === next.id)) throw new AppError(409, 'credential_exists', 'Security key นี้ลงทะเบียนแล้ว');
    const keys = this.creds(row).length + 1;
    const activate = row.status === 'invited' && ready(row, keys);
    await this.db.update(s.staffUsers).set({ webauthnCredentials: [...this.creds(row), next], ...(activate ? { status: 'active' } : {}), updatedAt: new Date() }).where(eq(s.staffUsers.id, row.id));
    return { registered: true, credentialId: next.id, keys, status: activate ? 'active' : row.status };
  }

  async loginOptions(email: string) {
    const [row] = await this.db.select().from(s.staffUsers).where(sql`lower(${s.staffUsers.email}) = ${email.toLowerCase()}`);
    // อีเมลที่ไม่มี / ยังไม่มี key ตอบรูปแบบเดียวกัน (ไม่เปิดเผยว่ามีพนักงานคนนี้) แล้วไปล้มตอน verify
    const creds = row ? this.creds(row) : [];
    const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'preferred', allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as never })) });
    return { options, challengeToken: sign('ops-login', { challenge: options.challenge, nonce: randomBytes(6).toString('hex') }, CHALLENGE_TTL) };
  }

  /** ตรวจลายเซ็นของ key แล้วออก session (cookie) · counter ต้องเพิ่มขึ้น (กันโคลน key) */
  async loginVerify(body: z.infer<typeof VerifyBody>) {
    const row = await this.assertion('ops-login', body);
    if (row.status === 'invited') throw new AppError(403, 'enrollment_incomplete', 'ตั้งรหัสผ่าน + แอป Authenticator หรือลงทะเบียน Security key ให้ครบ 2 อันก่อนเข้าใช้งาน');
    return this.session(row);
  }

  private session(row: StaffRow) {
    if (row.status !== 'active' || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) throw new AppError(401, 'login_failed', 'เข้าสู่ระบบไม่สำเร็จ');
    const token = sign(SESSION_PURPOSE, { sid: row.id }, config.sessionHours * 3600);
    return { token, staff: { id: row.id, email: row.email, name: row.name, roles: row.roles, department: row.department } };
  }

  // ---------------------------------------------------------------- รหัสผ่าน + Authenticator

  /** วิธีเข้าระบบที่บัญชีนี้มี (หน้าเว็บเลือกแสดงช่องรหัส 6 หลัก / ปุ่มแตะกุญแจ) */
  async methods(staffId: string) {
    const row = await this.staff(staffId);
    return { totp: !!row?.totpEnabledAt, totpEnabledAt: row?.totpEnabledAt ?? null, keys: row ? this.creds(row).map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt ?? null })) : [] };
  }

  private assertNotLocked(row: StaffRow) {
    if (row.lockedUntil && row.lockedUntil > new Date())
      throw new AppError(429, 'account_locked', `ใส่รหัสผิดหลายครั้ง บัญชีถูกล็อกชั่วคราว ลองใหม่หลัง ${LOCK_MINUTES} นาที`, { lockedUntil: row.lockedUntil });
  }

  /** นับครั้งที่ผิดติดกัน · ครบ LOCK_ATTEMPTS ล็อก LOCK_MINUTES นาที (กันเดารหัสผ่าน/รหัส 6 หลัก) */
  private async failed(row: StaffRow, message: string, code = 'login_failed') {
    const count = row.failedLoginCount + 1;
    const lock = count >= LOCK_ATTEMPTS;
    await this.db
      .update(s.staffUsers)
      .set({ failedLoginCount: lock ? 0 : count, lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null })
      .where(eq(s.staffUsers.id, row.id));
    if (lock) {
      await staffAudit(this.db, null, 'staff.locked', `${row.email} · ใส่รหัสผิด ${LOCK_ATTEMPTS} ครั้ง`, { type: 'staff', id: row.id });
      return new AppError(429, 'account_locked', `ใส่รหัสผิด ${LOCK_ATTEMPTS} ครั้ง บัญชีถูกล็อก ${LOCK_MINUTES} นาที`);
    }
    return new AppError(401, code, message, { attemptsLeft: LOCK_ATTEMPTS - count });
  }

  /** ตรวจรหัส 6 หลัก · รหัสเดิม (step เดิมหรือเก่ากว่า) ใช้ซ้ำไม่ได้ */
  private async checkTotp(row: StaffRow, code: string, failCode: string) {
    this.assertNotLocked(row);
    const step = row.totpSecretEnc ? verifyTotp(decryptSecret(row.totpSecretEnc), code) : null;
    if (step === null || (row.totpLastStep !== null && step <= row.totpLastStep)) throw await this.failed(row, 'รหัส 6 หลักไม่ถูกต้องหรือใช้ไปแล้ว · รอรหัสใหม่จากแอป', failCode);
    await this.db.update(s.staffUsers).set({ totpLastStep: step, failedLoginCount: 0, lockedUntil: null }).where(eq(s.staffUsers.id, row.id));
  }

  /** ขั้นที่ 1: อีเมล + รหัสผ่าน → mfaToken อายุ 5 นาทีไว้ใส่รหัส 6 หลัก */
  async loginPassword(body: z.infer<typeof PasswordLoginBody>) {
    const [row] = await this.db.select().from(s.staffUsers).where(sql`lower(${s.staffUsers.email}) = ${body.email.toLowerCase()}`);
    if (row) this.assertNotLocked(row);
    // ตรวจรหัสผ่านเสมอแม้ไม่พบบัญชี เพื่อไม่ให้เวลาตอบบอกว่ามีพนักงานคนนี้
    const ok = await verifyPassword(body.password, row?.passwordHash);
    if (!row || !row.totpEnabledAt) throw new AppError(401, 'login_failed', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    if (!ok) throw await this.failed(row, 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    if (row.status !== 'active' || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) throw new AppError(401, 'login_failed', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    return { mfaToken: sign('ops-mfa', { sid: row.id }, CHALLENGE_TTL), email: row.email };
  }

  /** ขั้นที่ 2: รหัส 6 หลักจากแอป → session */
  async loginTotp(body: z.infer<typeof TotpLoginBody>) {
    const t = verify<{ sid: string }>('ops-mfa', body.mfaToken);
    if (!t) throw new AppError(400, 'mfa_expired', 'หมดเวลาใส่รหัส 6 หลัก · เริ่มเข้าสู่ระบบใหม่');
    const row = await this.staff(t.sid);
    if (!row) throw new AppError(401, 'login_failed', 'เข้าสู่ระบบไม่สำเร็จ');
    await this.checkTotp(row, body.code, 'login_failed');
    return this.session(row);
  }

  /**
   * เริ่มตั้งรหัสผ่าน + แอป Authenticator: ด้วย enrollToken (พนักงานใหม่ / Owner ออกลิงก์ใหม่) หรือ session ที่ยืนยันตัวตนซ้ำแล้ว
   * secret ยังไม่บันทึก จนกว่าจะใส่รหัส 6 หลักจากแอปถูก (ถือไว้ใน setupToken แบบเข้ารหัส)
   */
  async passwordSetup(session: { sid: string; reauthed: boolean } | undefined, enrollToken: string | undefined) {
    const viaToken = enrollToken ? verify<{ sid: string }>('ops-enroll', enrollToken)?.sid : undefined;
    if (enrollToken && !viaToken) throw new AppError(401, 'enroll_token_invalid', 'ลิงก์ตั้งค่าไม่ถูกต้องหรือหมดอายุ · ขอลิงก์ใหม่จาก Owner');
    const sid = viaToken ?? session?.sid;
    if (!sid) throw new AppError(401, 'unauthorized', 'ต้องเข้าสู่ระบบก่อน');
    if (!viaToken && !session?.reauthed) throw new AppError(401, 'reauth_required', 'ยืนยันตัวตนอีกครั้งก่อนตั้งรหัสผ่าน');
    const row = await this.staff(sid);
    if (!row || row.status === 'disabled') throw new AppError(404, 'not_found', 'ไม่พบพนักงาน');
    const secret = newTotpSecret();
    return { secret, otpauthUrl: otpauthUrl(secret, row.email), email: row.email, setupToken: sign('ops-totp-setup', { sid, enc: encryptSecret(secret), via: viaToken ? 'enroll' : 'session' }, 15 * 60) };
  }

  /** บันทึกรหัสผ่าน + secret เมื่อรหัส 6 หลักจากแอปถูก · ค่าเดิมใช้ไม่ได้ทันที · พนักงานใหม่เปิดใช้งาน */
  async passwordVerify(body: z.infer<typeof PasswordVerifyBody>) {
    const t = verify<{ sid: string; enc: string; via: string }>('ops-totp-setup', body.setupToken);
    if (!t) throw new AppError(400, 'setup_expired', 'หมดเวลาตั้งค่า · เริ่มใหม่อีกครั้ง');
    const row = await this.staff(t.sid);
    if (!row || row.status === 'disabled') throw new AppError(404, 'not_found', 'ไม่พบพนักงาน');
    const step = verifyTotp(decryptSecret(t.enc), body.code);
    if (step === null) throw new AppError(422, 'totp_invalid', 'รหัส 6 หลักไม่ตรง · ตรวจว่าสแกน QR แล้ว และเวลาในมือถือตรง');
    const activate = row.status === 'invited';
    const [r] = await this.db
      .update(s.staffUsers)
      .set({ passwordHash: await hashPassword(body.password), totpSecretEnc: t.enc, totpEnabledAt: new Date(), totpLastStep: step, failedLoginCount: 0, lockedUntil: null, ...(activate ? { status: 'active' } : {}), updatedAt: new Date() })
      .where(eq(s.staffUsers.id, row.id))
      .returning();
    await staffAudit(this.db, null, 'staff.password_set', `${row.email} · ตั้งรหัสผ่าน + แอป Authenticator (${t.via === 'enroll' ? 'ลิงก์ตั้งค่า' : 'จากบัญชีตัวเอง'})`, { type: 'staff', id: row.id });
    return { ok: true, status: r.status };
  }

  /** ยืนยันตัวตนซ้ำด้วยรหัส 6 หลัก (G4) */
  async reauthTotp(staffId: string, code: string) {
    const row = await this.staff(staffId);
    if (!row?.totpEnabledAt) throw new AppError(422, 'totp_not_set', 'บัญชีนี้ยังไม่ได้ตั้งแอป Authenticator');
    await this.checkTotp(row, code, 'reauth_failed');
    return { token: sign(REAUTH_PURPOSE, { sid: staffId }, REAUTH_SECONDS), expiresInSeconds: REAUTH_SECONDS };
  }

  /** ลบ Security key ของตัวเอง · ต้องเหลือวิธีเข้าระบบอย่างน้อย 1 วิธี */
  async removeOwnKey(me: Staff, credentialId: string) {
    const row = await this.staff(me.id);
    if (!row) throw new AppError(404, 'not_found', 'ไม่พบพนักงาน');
    const creds = this.creds(row);
    const key = creds.find((c) => c.id === credentialId);
    if (!key) throw new AppError(404, 'not_found', 'ไม่พบ Security key');
    if (creds.length === 1 && !row.totpEnabledAt) throw new AppError(422, 'last_key', 'ตั้งรหัสผ่าน + แอป Authenticator ก่อนลบ Security key อันสุดท้าย');
    await this.db.update(s.staffUsers).set({ webauthnCredentials: creds.filter((c) => c.id !== credentialId), updatedAt: new Date() }).where(eq(s.staffUsers.id, row.id));
    await staffAudit(this.db, me, 'staff.key_removed', `${row.email} · ${key.name} (ลบเอง)`, { type: 'staff', id: row.id });
    return { keys: creds.length - 1 };
  }

  /** เริ่มยืนยันตัวตนซ้ำ (G4) · ใช้ key ของพนักงานที่ล็อกอินอยู่เท่านั้น */
  async reauthOptions(staffId: string) {
    const row = await this.staff(staffId);
    if (!row) throw new AppError(404, 'not_found', 'ไม่พบพนักงาน');
    const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'preferred', allowCredentials: this.creds(row).map((c) => ({ id: c.id, transports: c.transports as never })) });
    return { options, challengeToken: sign('ops-reauth-ch', { sid: staffId, challenge: options.challenge }, CHALLENGE_TTL) };
  }

  /** ยืนยันตัวตนซ้ำสำเร็จ → โทเค็นอายุ 15 นาที (cookie แยกจาก session) */
  async reauthVerify(staffId: string, body: z.infer<typeof VerifyBody>) {
    const ch = verify<{ sid: string; challenge: string }>('ops-reauth-ch', body.challengeToken);
    if (!ch || ch.sid !== staffId) throw new AppError(400, 'challenge_invalid', 'Challenge หมดอายุหรือไม่ถูกต้อง · เริ่มใหม่');
    const row = await this.assertion('ops-reauth-ch', body);
    if (row.id !== staffId) throw new AppError(401, 'reauth_failed', 'Security key ไม่ใช่ของบัญชีนี้');
    return { token: sign(REAUTH_PURPOSE, { sid: staffId }, REAUTH_SECONDS), expiresInSeconds: REAUTH_SECONDS };
  }

  /** ตรวจลายเซ็นของ key กับ challenge แล้วเลื่อน counter · คืนแถวพนักงานเจ้าของ key */
  private async assertion(purpose: string, body: z.infer<typeof VerifyBody>) {
    const fail = () => new AppError(401, 'login_failed', 'เข้าสู่ระบบไม่สำเร็จ');
    const ch = verify<{ challenge: string }>(purpose, body.challengeToken);
    if (!ch) throw new AppError(400, 'challenge_invalid', 'Challenge หมดอายุหรือไม่ถูกต้อง · เริ่มใหม่');
    const response = body.response as unknown as AuthenticationResponseJSON;
    const [row] = await this.db.select().from(s.staffUsers).where(sql`${s.staffUsers.webauthnCredentials} @> ${JSON.stringify([{ id: response.id }])}::jsonb`);
    if (!row) throw fail();
    const cred = this.creds(row).find((c) => c.id === response.id)!;
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpId,
        credential: { id: cred.id, publicKey: Buffer.from(cred.publicKey, 'base64url'), counter: cred.counter, transports: cred.transports as never },
        requireUserVerification: false,
      });
    } catch {
      throw fail();
    }
    if (!v.verified) throw fail();
    await this.db.update(s.staffUsers).set({ webauthnCredentials: this.creds(row).map((c) => (c.id === cred.id ? { ...c, counter: v.authenticationInfo.newCounter, lastUsedAt: new Date().toISOString() } : c)), updatedAt: new Date() }).where(eq(s.staffUsers.id, row.id));
    return row;
  }
}
