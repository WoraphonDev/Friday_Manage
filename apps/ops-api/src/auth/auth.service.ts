import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { SESSION_PURPOSE } from './auth.guard.js';
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
}

export const EnrollBody = z.object({ enrollToken: z.string().min(10).optional(), name: z.string().trim().min(1).max(60).default('Security key') });
export const VerifyBody = z.object({ challengeToken: z.string().min(10), response: z.record(z.string(), z.unknown()), name: z.string().trim().min(1).max(60).optional() });
export const LoginOptionsBody = z.object({ email: z.email() });

/** โทเค็นลงทะเบียนครั้งแรก (ออกโดยสคริปต์ `pnpm --filter @friday/ops-api enroll <email>` ใช้ได้ 1 ชั่วโมง) */
export const signEnrollToken = (staffId: string) => sign('ops-enroll', { sid: staffId }, 3600);

/** Security key (WebAuthn / FIDO2) ของพนักงาน Friday · ไม่มีรหัสผ่าน */
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
    await this.db.update(s.staffUsers).set({ webauthnCredentials: [...this.creds(row), next], updatedAt: new Date() }).where(eq(s.staffUsers.id, row.id));
    return { registered: true, credentialId: next.id, keys: this.creds(row).length + 1 };
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
    const fail = () => new AppError(401, 'login_failed', 'เข้าสู่ระบบไม่สำเร็จ');
    const ch = verify<{ challenge: string }>('ops-login', body.challengeToken);
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
    await this.db.update(s.staffUsers).set({ webauthnCredentials: this.creds(row).map((c) => (c.id === cred.id ? { ...c, counter: v.authenticationInfo.newCounter } : c)), updatedAt: new Date() }).where(eq(s.staffUsers.id, row.id));
    const token = sign(SESSION_PURPOSE, { sid: row.id }, config.sessionHours * 3600);
    return { token, staff: { id: row.id, email: row.email, name: row.name, role: row.role } };
  }
}
