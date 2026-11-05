import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { eq } from 'drizzle-orm';
import type { Response } from 'express';
import { AppError } from '../common/errors.js';
import type { AppRequest } from '../common/request.js';
import { config } from '../config.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { authTimes } from './auth.config.js';
import { signToken, verifyToken } from './crypto.js';
import { MfaService } from './mfa.service.js';
import { SecurityService } from './security.service.js';
import { SESSION_COOKIE, SessionService } from './sessions.js';

const { users } = schema;

export const MFA_TRUST_COOKIE = 'fm_mfa_trust';

export type LoginResult = { id: string } | { mfaRequired: true; mfaToken: string; email: string };

/** ขั้นสุดท้ายของการล็อกอินที่ใช้ร่วมกันระหว่างรหัสผ่าน, 2FA และ OAuth · ใช้ friday_system เพราะยังไม่มี Session */
@Injectable()
export class LoginService {
  constructor(
    @Inject(SYSTEM_DB) private readonly db: Db,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly security: SecurityService,
  ) {}

  /** บัญชีถูกล็อกจากการใส่รหัสผิดหลายครั้ง → 429 */
  assertNotLocked(user: { lockedUntil: Date | null }) {
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError(429, 'account_locked', 'บัญชีถูกล็อกชั่วคราวเพราะใส่รหัสผิดหลายครั้ง', { lockedUntil: user.lockedUntil });
    }
  }

  /**
   * นับครั้งที่ใส่รหัสผิด (รหัสผ่านหรือรหัส 2FA) ตาม security_policies ที่เข้มที่สุดของผู้ใช้
   * J1: "ลองได้อีก 4 ครั้งก่อนบัญชีถูกล็อก 15 นาที"
   */
  async recordFailure(user: { id: string; failed: number }, req: AppRequest, what: 'password' | 'mfa') {
    const policy = await this.security.policyFor(user.id);
    const failed = user.failed + 1;
    const lock = failed >= policy.lockoutAttempts;
    await this.db
      .update(users)
      .set({ failedLoginCount: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + policy.lockoutMinutes * 60_000) : null })
      .where(eq(users.id, user.id));
    await this.security.audit(
      user.id,
      'secu.login_failed',
      `${what === 'mfa' ? 'รหัส 2FA' : 'รหัสผ่าน'}ไม่ถูกต้อง (ครั้งที่ ${failed})${lock ? ` · ล็อกบัญชี ${policy.lockoutMinutes} นาที` : ''}`,
      req,
      null,
    );
    return { attemptsLeft: lock ? 0 : policy.lockoutAttempts - failed, lockoutMinutes: policy.lockoutMinutes };
  }

  async resetFailures(userId: string) {
    await this.db.update(users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, userId));
  }

  /**
   * ผ่านขั้นแรกแล้ว (รหัสผ่านหรือ OAuth): ถ้าเปิด 2FA และอุปกรณ์นี้ไม่ได้ถูกจำไว้ ให้ไปขั้น 2FA ด้วย mfaToken
   * mfaToken เป็น token ที่ลงลายมือชื่อ อายุ 5 นาที ไม่เก็บในฐานข้อมูล
   */
  async complete(user: { id: string; email: string }, remember: boolean, req: AppRequest, res: Response): Promise<LoginResult> {
    if (await this.mfa.isEnabled(this.db, user.id)) {
      const trusted = await this.trustedDevice(user.id, req);
      if (!trusted) {
        return {
          mfaRequired: true,
          mfaToken: signToken('mfa-login', { u: user.id, r: remember }, authTimes.mfaTokenMinutes * 60),
          email: user.email,
        };
      }
      await this.resetFailures(user.id);
      // ย้ายการจำอุปกรณ์มาไว้ที่ Session ใหม่
      await this.sessions.setTrust(trusted.sessionId, null);
      await this.startSession(user.id, remember, req, res, trusted.until);
      return { id: user.id };
    }
    await this.resetFailures(user.id);
    await this.startSession(user.id, remember, req, res);
    return { id: user.id };
  }

  /** คืน userId และ remember จาก mfaToken (null = หมดอายุหรือถูกแก้) */
  readMfaToken(token: string) {
    const p = verifyToken<{ u: string; r: boolean }>('mfa-login', token);
    return p ? { userId: p.u, remember: !!p.r } : null;
  }

  async startSession(userId: string, remember: boolean, req: AppRequest, res: Response, trustUntil?: Date | null) {
    const s = await this.sessions.create(userId, { userAgent: req.get('user-agent'), ip: req.ip, remember, mfaTrustedUntil: trustUntil });
    res.cookie(SESSION_COOKIE, s.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      path: '/',
      ...(s.rememberUntil ? { expires: s.rememberUntil } : {}),
    });
    if (trustUntil) {
      const ttl = Math.max(1, Math.floor((trustUntil.getTime() - Date.now()) / 1000));
      res.cookie(MFA_TRUST_COOKIE, signToken('mfa-trust', { s: s.sessionId, u: userId }, ttl), {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.cookieSecure,
        path: '/',
        expires: trustUntil,
      });
    }
    return s;
  }

  /** คุกกี้จำอุปกรณ์ชี้ไปที่ Session ที่ผ่าน 2FA แล้ว · ใช้ได้เมื่อ Session นั้นยังมี mfa_trusted_until อยู่ */
  private async trustedDevice(userId: string, req: AppRequest) {
    const p = verifyToken<{ s: string; u: string }>('mfa-trust', req.cookies?.[MFA_TRUST_COOKIE]);
    if (!p || p.u !== userId) return null;
    const until = await this.sessions.trustedUntil(p.s, userId);
    return until ? { sessionId: p.s, until } : null;
  }
}
