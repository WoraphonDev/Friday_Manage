import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { type Db, schema } from '@friday/db';
import { and, asc, desc, eq, gt, isNull, ne, or, sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { AppError, notFound } from '../common/errors.js';
import { type AppRequest, Auth, type AuthInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { AccountService, devToken } from './account.service.js';
import { authTimes } from './auth.config.js';
import { AuthTokenService } from './auth-tokens.js';
import { encryptSecret, newTotpSecret, otpauthUrl } from './crypto.js';
import { MFA_TRUST_COOKIE } from './login.service.js';
import { MfaService } from './mfa.service.js';
import { SecurityService } from './security.service.js';
import { SESSION_COOKIE } from './sessions.js';

const { users, userSessions, userIdentities, mfaFactors } = schema;

const uuid = z.uuid();
const PasswordChangeBody = z.object({
  currentPassword: z.string().max(200).optional(),
  newPassword: z.string().min(1).max(200),
  logoutOthers: z.boolean().default(true),
});
const EmailChangeBody = z.object({ newEmail: z.email().max(254), password: z.string().max(200).optional() });
const EmailConfirmBody = z.union([z.object({ token: z.string().min(10).max(200) }), z.object({ code: z.string().trim().regex(/^\d{6}$/, 'รหัส 6 หลัก') })]);
const CodeBody = z.object({ code: z.string().trim().min(6).max(20) });

const wrongPassword = () => new AppError(400, 'wrong_password', 'รหัสผ่านปัจจุบันไม่ถูกต้อง');
const invalidMfaCode = () => new AppError(400, 'invalid_mfa_code', 'รหัสยืนยันไม่ถูกต้อง');

/**
 * หน้า I (Profile) › ความปลอดภัย: Session, รหัสผ่าน, อีเมล, 2FA และวิธีเข้าสู่ระบบ
 * ข้อมูลล็อกอินของตัวเองอ่าน / แก้ผ่าน TenantDb (RLS own_rows) · ใช้ SYSTEM_DB เฉพาะจุดที่ระบุเหตุผล
 */
@Controller('me')
export class MeSecurityController {
  constructor(
    private readonly db: TenantDb,
    // ตรวจอีเมลซ้ำกับผู้ใช้ทุกคน (RLS เห็นแค่คนใน Workspace เดียวกัน)
    @Inject(SYSTEM_DB) private readonly system: Db,
    private readonly mfa: MfaService,
    private readonly security: SecurityService,
    private readonly tokens: AuthTokenService,
    private readonly account: AccountService,
  ) {}

  // ---------------------------------------------------------------------------
  // Session (อุปกรณ์ที่ล็อกอินอยู่)
  // ---------------------------------------------------------------------------

  @Get('sessions')
  async sessions(@Auth() auth: AuthInfo) {
    const { sessionIdleHours } = await this.security.policyFor(auth.userId);
    const rows = await this.db.run(auth, null, (tx) =>
      tx
        .select({
          id: userSessions.id,
          deviceName: userSessions.deviceName,
          userAgent: userSessions.userAgent,
          ip: userSessions.ip,
          location: userSessions.location,
          createdAt: userSessions.createdAt,
          lastSeenAt: userSessions.lastSeenAt,
          rememberUntil: userSessions.rememberUntil,
          mfaTrustedUntil: userSessions.mfaTrustedUntil,
        })
        .from(userSessions)
        .where(
          and(
            eq(userSessions.userId, auth.userId),
            isNull(userSessions.revokedAt),
            or(gt(userSessions.rememberUntil, sql`now()`), sql`${userSessions.lastSeenAt} > now() - make_interval(hours => ${sessionIdleHours})`),
          ),
        )
        .orderBy(desc(userSessions.lastSeenAt)),
    );
    return { items: rows.map((r) => ({ ...r, current: r.id === auth.sessionId })) };
  }

  /** ออกจากระบบทุกเครื่องยกเว้นเครื่องนี้ */
  @Delete('sessions')
  async revokeOthers(@Auth() auth: AuthInfo, @Req() req: AppRequest) {
    const rows = await this.db.run(auth, null, async (tx) => {
      const others = and(eq(userSessions.userId, auth.userId), ne(userSessions.id, auth.sessionId));
      await tx.update(userSessions).set({ mfaTrustedUntil: null }).where(others);
      return tx.update(userSessions).set({ revokedAt: new Date() }).where(and(others, isNull(userSessions.revokedAt))).returning({ id: userSessions.id });
    });
    if (rows.length) await this.security.audit(auth.userId, 'secu.session_revoked', `ออกจากระบบอุปกรณ์อื่นทั้งหมด ${rows.length} เครื่อง`, req);
    return { revoked: rows.length };
  }

  /** ออกจากระบบรายเครื่อง · ยกเลิกการจำอุปกรณ์สำหรับ 2FA ของเครื่องนั้นด้วย */
  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeOne(@Auth() auth: AuthInfo, @Param('id') id: string, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const sessionId = parse(uuid, id);
    const [row] = await this.db.run(auth, null, (tx) =>
      tx
        .update(userSessions)
        .set({ revokedAt: new Date(), mfaTrustedUntil: null })
        .where(and(eq(userSessions.id, sessionId), eq(userSessions.userId, auth.userId), isNull(userSessions.revokedAt)))
        .returning({ id: userSessions.id, deviceName: userSessions.deviceName }),
    );
    if (!row) throw notFound('Session');
    await this.security.audit(auth.userId, 'secu.session_revoked', `ออกจากระบบอุปกรณ์ ${row.deviceName ?? 'ไม่ทราบชื่อ'}`, req);
    if (sessionId === auth.sessionId) {
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.clearCookie(MFA_TRUST_COOKIE, { path: '/' });
    }
  }

  // ---------------------------------------------------------------------------
  // รหัสผ่านและอีเมล
  // ---------------------------------------------------------------------------

  /** บัญชีที่ใช้แค่ Google / Microsoft ตั้งรหัสผ่านครั้งแรกได้โดยไม่ต้องใส่รหัสเดิม */
  @Post('password\\:change')
  @HttpCode(200)
  async changePassword(@Auth() auth: AuthInfo, @Body() body: unknown, @Req() req: AppRequest) {
    const input = parse(PasswordChangeBody, body);
    const user = await this.user(auth);
    if (user.passwordHash && !(input.currentPassword && (await verify(user.passwordHash, input.currentPassword)))) throw wrongPassword();
    await this.security.assertPassword(auth.userId, input.newPassword, 'newPassword');
    const passwordHash = await hash(input.newPassword);

    const loggedOut = await this.db.run(auth, null, async (tx) => {
      await tx.update(users).set({ passwordHash, passwordChangedAt: new Date() }).where(eq(users.id, auth.userId));
      await this.account.ensurePasswordIdentity(tx, auth.userId);
      if (!input.logoutOthers) return 0;
      const others = and(eq(userSessions.userId, auth.userId), ne(userSessions.id, auth.sessionId));
      await tx.update(userSessions).set({ mfaTrustedUntil: null }).where(others);
      const rows = await tx.update(userSessions).set({ revokedAt: new Date() }).where(and(others, isNull(userSessions.revokedAt))).returning({ id: userSessions.id });
      return rows.length;
    });
    await this.security.audit(auth.userId, 'secu.password_changed', `${user.passwordHash ? 'เปลี่ยน' : 'ตั้ง'}รหัสผ่าน${input.logoutOthers ? ` · ออกจากระบบอุปกรณ์อื่น ${loggedOut} เครื่อง` : ''}`, req);
    await this.account.mail(user.email, 'รหัสผ่านของคุณถูกเปลี่ยน · Friday Manage', [
      'รหัสผ่านของบัญชี Friday Manage ถูกเปลี่ยนเรียบร้อย',
      'ถ้าไม่ได้ทำเอง ให้ติดต่อ Admin ของ Workspace ทันที',
    ]);
    return { ok: true, loggedOutSessions: loggedOut };
  }

  /** ขอเปลี่ยนอีเมล → ส่งรหัส 6 หลัก + ลิงก์ไปที่อีเมลใหม่ · เปลี่ยนจริงเมื่อยืนยันแล้ว (me/email:confirm) */
  @Post('email\\:change')
  @HttpCode(202)
  async changeEmail(@Auth() auth: AuthInfo, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parse(EmailChangeBody, body);
    const newEmail = input.newEmail.toLowerCase();
    const user = await this.user(auth);
    if (user.passwordHash && !(input.password && (await verify(user.passwordHash, input.password)))) throw wrongPassword();
    if (newEmail === user.email.toLowerCase()) throw new AppError(400, 'same_email', 'อีเมลใหม่ต้องไม่ซ้ำกับอีเมลเดิม');
    const [taken] = await this.system.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${newEmail}`);
    if (taken) throw new AppError(409, 'email_taken', 'อีเมลนี้มีบัญชีแล้ว');
    const wait = await this.tokens.resendWait(auth.userId, 'change_email');
    if (wait > 0) throw new AppError(429, 'resend_too_soon', `ส่งใหม่ได้ใน ${wait} วินาที`, { retryAfter: wait });

    const { token, code } = await this.tokens.issue(auth.userId, 'change_email', authTimes.changeEmailMinutes, newEmail);
    await this.account.mail(newEmail, `รหัสยืนยันอีเมลใหม่ ${code} · Friday Manage`, [
      `รหัสยืนยันอีเมลใหม่ของคุณคือ ${code}`,
      `หรือกดลิงก์นี้: ${this.account.link('/signup', token!)}`,
      'ถ้าไม่ได้ขอเปลี่ยนอีเมล ไม่ต้องทำอะไร',
    ]);
    devToken(res, { code, token });
    return { pendingEmail: newEmail, retryAfter: authTimes.resendSeconds };
  }

  @Post('email\\:confirm')
  @HttpCode(200)
  async confirmEmail(@Auth() auth: AuthInfo, @Body() body: unknown, @Req() req: AppRequest) {
    const input = parse(EmailConfirmBody, body);
    const row =
      'code' in input
        ? await this.tokens.consumeCode(auth.userId, 'change_email', input.code)
        : (await this.tokens.peekLink(input.token, ['change_email']))?.userId === auth.userId
          ? await this.tokens.consumeLink(input.token, ['change_email'])
          : null;
    if (!row) throw new AppError(400, 'invalid_token', 'ลิงก์หรือรหัสไม่ถูกต้อง หรือหมดอายุแล้ว · ขอใหม่อีกครั้ง');
    return { emailVerified: true, ...(await this.account.applyEmailChange(row, req)) };
  }

  // ---------------------------------------------------------------------------
  // 2FA (Authenticator app)
  // ---------------------------------------------------------------------------

  @Get('mfa')
  async mfaStatus(@Auth() auth: AuthInfo) {
    const f = await this.db.run(auth, null, (tx) => this.mfa.factor(tx, auth.userId));
    const { mfaRequired } = await this.security.policyFor(auth.userId);
    return {
      enabled: !!f?.enabledAt,
      enabledAt: f?.enabledAt ?? null,
      backupCodesLeft: f?.enabledAt ? f.backupCodesHash.length : 0,
      setupPending: !!f && !f.enabledAt,
      requiredByPolicy: mfaRequired,
    };
  }

  /** ขั้นแรก: ได้ secret สำหรับสแกน QR · ยังไม่เปิดใช้จนกว่าจะยืนยันรหัสแรก (me/mfa:enable) */
  @Post('mfa\\:setup')
  @HttpCode(200)
  async mfaSetup(@Auth() auth: AuthInfo) {
    const user = await this.user(auth);
    const secret = newTotpSecret();
    await this.db.run(auth, null, async (tx) => {
      const f = await this.mfa.factor(tx, auth.userId);
      if (f?.enabledAt) throw new AppError(409, 'mfa_already_enabled', 'เปิด 2FA อยู่แล้ว');
      await tx
        .insert(mfaFactors)
        .values({ userId: auth.userId, type: 'totp', secretEnc: encryptSecret(secret) })
        .onConflictDoUpdate({ target: mfaFactors.userId, set: { secretEnc: encryptSecret(secret), backupCodesHash: [], enabledAt: null } });
    });
    return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
  }

  /** ยืนยันรหัสแรกจากแอปแล้วเปิดใช้ · ได้ Backup code 10 รหัส (แสดงครั้งเดียว) */
  @Post('mfa\\:enable')
  @HttpCode(200)
  async mfaEnable(@Auth() auth: AuthInfo, @Body() body: unknown, @Req() req: AppRequest) {
    const { code } = parse(CodeBody, body);
    const backup = this.mfa.newBackupCodes(auth.userId);
    await this.db.run(auth, null, async (tx) => {
      const f = await this.mfa.factor(tx, auth.userId);
      if (!f) throw new AppError(409, 'mfa_setup_required', 'ต้องเริ่มตั้งค่า 2FA ก่อน (me/mfa:setup)');
      if (f.enabledAt) throw new AppError(409, 'mfa_already_enabled', 'เปิด 2FA อยู่แล้ว');
      if (!this.mfa.checkTotp(auth.userId, f.secretEnc, code)) throw invalidMfaCode();
      await tx.update(mfaFactors).set({ enabledAt: new Date(), backupCodesHash: backup.hashes }).where(eq(mfaFactors.userId, auth.userId));
    });
    await this.security.audit(auth.userId, 'secu.mfa_enabled', 'เปิด 2FA (Authenticator app)', req);
    return { enabled: true, backupCodes: backup.codes };
  }

  /** ปิด 2FA ต้องใส่รหัสจากแอปหรือ Backup code · ปิดไม่ได้ถ้า Workspace ใดบังคับ */
  @Post('mfa\\:disable')
  @HttpCode(200)
  async mfaDisable(@Auth() auth: AuthInfo, @Body() body: unknown, @Req() req: AppRequest) {
    const { code } = parse(CodeBody, body);
    if ((await this.security.policyFor(auth.userId)).mfaRequired) {
      throw new AppError(403, 'mfa_required_by_policy', 'ปิด 2FA ไม่ได้ เพราะ Workspace ของคุณบังคับใช้');
    }
    await this.db.run(auth, null, async (tx) => {
      if (!(await this.mfa.isEnabled(tx, auth.userId))) throw new AppError(409, 'mfa_not_enabled', 'ยังไม่ได้เปิด 2FA');
      if (!(await this.mfa.verify(tx, auth.userId, code))) throw invalidMfaCode();
      await tx.delete(mfaFactors).where(eq(mfaFactors.userId, auth.userId));
      // อุปกรณ์ที่เคยจำไว้ต้องยืนยันใหม่ถ้าเปิด 2FA อีกครั้ง
      await tx.update(userSessions).set({ mfaTrustedUntil: null }).where(eq(userSessions.userId, auth.userId));
    });
    this.mfa.forget(auth.userId);
    await this.security.audit(auth.userId, 'secu.mfa_disabled', 'ปิด 2FA', req);
    return { enabled: false };
  }

  /** ออก Backup code ชุดใหม่ (ชุดเดิมใช้ไม่ได้ทันที) · ต้องใส่รหัสจากแอปหรือ Backup code */
  @Post('mfa/backup-codes\\:regenerate')
  @HttpCode(200)
  async regenerateBackupCodes(@Auth() auth: AuthInfo, @Body() body: unknown, @Req() req: AppRequest) {
    const { code } = parse(CodeBody, body);
    const backup = this.mfa.newBackupCodes(auth.userId);
    await this.db.run(auth, null, async (tx) => {
      if (!(await this.mfa.isEnabled(tx, auth.userId))) throw new AppError(409, 'mfa_not_enabled', 'ยังไม่ได้เปิด 2FA');
      if (!(await this.mfa.verify(tx, auth.userId, code))) throw invalidMfaCode();
      await tx.update(mfaFactors).set({ backupCodesHash: backup.hashes }).where(eq(mfaFactors.userId, auth.userId));
    });
    await this.security.audit(auth.userId, 'secu.backup_codes_regenerated', 'ออก Backup code ชุดใหม่', req);
    return { backupCodes: backup.codes };
  }

  // ---------------------------------------------------------------------------
  // วิธีเข้าสู่ระบบที่ผูกไว้ (รหัสผ่าน, Google, Microsoft)
  // ---------------------------------------------------------------------------

  @Get('identities')
  async identities(@Auth() auth: AuthInfo) {
    const user = await this.user(auth);
    const rows = await this.db.run(auth, null, (tx) =>
      tx
        .select({ id: userIdentities.id, provider: userIdentities.provider, createdAt: userIdentities.createdAt })
        .from(userIdentities)
        .where(eq(userIdentities.userId, auth.userId))
        .orderBy(asc(userIdentities.createdAt)),
    );
    return {
      items: rows.map((r) => ({
        ...r,
        // I: "รหัสผ่าน · เปลี่ยนล่าสุด 3 เดือนก่อน"
        ...(r.provider === 'password' ? { passwordChangedAt: user.passwordChangedAt } : {}),
        canDelete: rows.length > 1,
      })),
    };
  }

  /** ยกเลิกการผูก · ลบวิธีสุดท้ายไม่ได้ · ลบ "รหัสผ่าน" = ล้างรหัสผ่านของบัญชีด้วย */
  @Delete('identities/:id')
  @HttpCode(204)
  async deleteIdentity(@Auth() auth: AuthInfo, @Param('id') id: string, @Req() req: AppRequest) {
    const identityId = parse(uuid, id);
    const removed = await this.db.run(auth, null, async (tx) => {
      const rows = await tx.select({ id: userIdentities.id, provider: userIdentities.provider }).from(userIdentities).where(eq(userIdentities.userId, auth.userId)).for('update');
      const target = rows.find((r) => r.id === identityId);
      if (!target) throw notFound('วิธีเข้าสู่ระบบ');
      if (rows.length <= 1) throw new AppError(409, 'last_login_method', 'ต้องมีวิธีเข้าสู่ระบบอย่างน้อย 1 วิธี');
      await tx.delete(userIdentities).where(eq(userIdentities.id, identityId));
      if (target.provider === 'password') await tx.update(users).set({ passwordHash: null }).where(eq(users.id, auth.userId));
      return target;
    });
    const label = { password: 'รหัสผ่าน', google: 'Google', microsoft: 'Microsoft', saml: 'SAML', oidc: 'OIDC' }[removed.provider];
    await this.security.audit(auth.userId, 'secu.identity_unlinked', `ยกเลิกการเข้าสู่ระบบด้วย ${label}`, req);
  }

  private async user(auth: AuthInfo) {
    const [u] = await this.db.run(auth, null, (tx) =>
      tx.select({ email: users.email, passwordHash: users.passwordHash, passwordChangedAt: users.passwordChangedAt }).from(users).where(eq(users.id, auth.userId)),
    );
    return u;
  }
}
