import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { type Db, schema } from '@friday/db';
import { eq, sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { AppError } from '../common/errors.js';
import { type AppRequest, Auth, type AuthInfo, Public } from '../common/request.js';
import { parse } from '../common/validate.js';
import { AccountService, devToken } from './account.service.js';
import { authTimes } from './auth.config.js';
import { AuthTokenService } from './auth-tokens.js';
import { LoginService } from './login.service.js';
import { MfaService } from './mfa.service.js';
import { SecurityService } from './security.service.js';
import { CSRF_COOKIE, newToken, SESSION_COOKIE, SessionService } from './sessions.js';

const { users, userIdentities } = schema;

// J2: อย่างน้อย 8 ตัว มีตัวพิมพ์ใหญ่และตัวเลข
const password = z
  .string()
  .min(8)
  .max(200)
  .regex(/[A-Z]/, 'ต้องมีตัวพิมพ์ใหญ่')
  .regex(/[0-9]/, 'ต้องมีตัวเลข');

const SignupBody = z.object({
  email: z.email().max(254),
  password,
  displayName: z.string().trim().min(1).max(80),
  acceptTerms: z.literal(true),
});
const LoginBody = z.object({ email: z.email(), password: z.string().min(1).max(200), remember: z.boolean().default(false) });
const MfaLoginBody = z.object({ mfaToken: z.string().min(1).max(2000), code: z.string().trim().min(6).max(20), trustDevice: z.boolean().default(false) });
const VerifyEmailBody = z.union([
  z.object({ token: z.string().min(10).max(200) }),
  z.object({ email: z.email().optional(), code: z.string().trim().regex(/^\d{6}$/, 'รหัส 6 หลัก') }),
]);
const EmailBody = z.object({ email: z.email().max(254) });
const ResendBody = z.object({ email: z.email().max(254).optional() });
const ResetBody = z.object({ token: z.string().min(10).max(200), newPassword: z.string().min(1).max(200), logoutAll: z.boolean().default(true) });

const invalidToken = () => new AppError(400, 'invalid_token', 'ลิงก์หรือรหัสไม่ถูกต้อง หรือหมดอายุแล้ว · ขอใหม่อีกครั้ง');

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(SYSTEM_DB) private readonly db: Db,
    private readonly sessions: SessionService,
    private readonly login_: LoginService,
    private readonly tokens: AuthTokenService,
    private readonly account: AccountService,
    private readonly mfa: MfaService,
    private readonly security: SecurityService,
  ) {}

  /** ออก CSRF token (เรียกครั้งแรกตอนเปิดหน้าเว็บ) */
  @Public()
  @Get('csrf')
  csrf(@Res({ passthrough: true }) res: Response) {
    const token = newToken();
    res.cookie(CSRF_COOKIE, token, { sameSite: 'lax', secure: config.cookieSecure, path: '/' });
    return { csrfToken: token };
  }

  @Public()
  @Post('signup')
  async signup(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const input = parse(SignupBody, body);
    const email = input.email.toLowerCase();
    const passwordHash = await hash(input.password);

    const userId = await this.db.transaction(async (tx) => {
      const [exists] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
      if (exists) throw new AppError(409, 'email_taken', 'อีเมลนี้มีบัญชีแล้ว · เข้าสู่ระบบแทน');
      const [user] = await tx.insert(users).values({ email, displayName: input.displayName, passwordHash, passwordChangedAt: new Date() }).returning({ id: users.id });
      await tx.insert(userIdentities).values({ userId: user.id, provider: 'password', providerSubject: user.id });
      return user.id;
    });

    // การส่งอีเมลปิดไว้ช่วงแรก (docs/tech-stack.md) จึงยังไม่บังคับยืนยันก่อนใช้งาน
    await this.sendVerifyEmail(userId, email, res);
    await this.login_.startSession(userId, false, req, res);
    res.status(201);
    return { id: userId, email, displayName: input.displayName };
  }

  /** J2 · ยืนยันอีเมลด้วยลิงก์ ({ token }) หรือรหัส 6 หลัก ({ email, code } · ไม่ส่ง email ใช้บัญชีที่ล็อกอินอยู่) */
  @Public()
  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(@Body() body: unknown, @Req() req: AppRequest) {
    const input = parse(VerifyEmailBody, body);
    if ('token' in input) {
      // ลิงก์ในอีเมลใช้ได้ทั้งยืนยันอีเมลตอนสมัครและยืนยันอีเมลใหม่ (me/email:change)
      const row = await this.tokens.consumeLink(input.token, ['verify_email', 'change_email']);
      if (!row) throw invalidToken();
      if (row.purpose === 'change_email') return { emailVerified: true, ...(await this.account.applyEmailChange(row, req)) };
      return this.markVerified(row.userId);
    }
    const user = await this.findUser(input.email, req);
    if (!user) throw invalidToken();
    const row = await this.tokens.consumeCode(user.id, 'verify_email', input.code);
    if (!row) throw invalidToken();
    return this.markVerified(user.id);
  }

  /** ส่งรหัสยืนยันอีเมลใหม่ ได้ทุก 60 วินาที · ไม่บอกว่ามีบัญชีหรือไม่ */
  @Public()
  @Post('verify-email\\:resend')
  @HttpCode(202)
  async resendVerifyEmail(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const input = parse(ResendBody, body ?? {});
    const user = await this.findUser(input.email, req);
    if (user && !user.emailVerifiedAt) {
      const wait = await this.tokens.resendWait(user.id, 'verify_email');
      if (wait > 0) throw new AppError(429, 'resend_too_soon', `ส่งใหม่ได้ใน ${wait} วินาที`, { retryAfter: wait });
      await this.sendVerifyEmail(user.id, user.email, res);
    }
    return { retryAfter: authTimes.resendSeconds };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const input = parse(LoginBody, body);
    const [user] = await this.db
      .select({ id: users.id, email: users.email, passwordHash: users.passwordHash, failed: users.failedLoginCount, lockedUntil: users.lockedUntil, disabledAt: users.disabledAt })
      .from(users)
      .where(sql`lower(${users.email}) = ${input.email.toLowerCase()}`);

    if (user) this.login_.assertNotLocked(user);
    const ok = !!user?.passwordHash && !user.disabledAt && (await verify(user.passwordHash, input.password));
    if (!ok) {
      if (user) {
        const left = await this.login_.recordFailure(user, req, 'password');
        // J1: "ลองได้อีก 4 ครั้งก่อนบัญชีถูกล็อก 15 นาที"
        throw new AppError(401, 'invalid_credentials', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง', left);
      }
      throw new AppError(401, 'invalid_credentials', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    }
    // เปิด 2FA อยู่ → ตอบ { mfaRequired, mfaToken } แทนการเปิด Session (J1 ขั้นที่ 2)
    return this.login_.complete(user, input.remember, req, res);
  }

  /** J1 ขั้นที่ 2 · รหัส 6 หลักจากแอป Authenticator หรือ Backup code · trustDevice = ไม่ถามอีก 30 วันบนอุปกรณ์นี้ */
  @Public()
  @Post('login/mfa')
  @HttpCode(200)
  async loginMfa(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const input = parse(MfaLoginBody, body);
    const t = this.login_.readMfaToken(input.mfaToken);
    if (!t) throw new AppError(401, 'mfa_token_invalid', 'ขั้นตอนยืนยันตัวตนหมดเวลา · เข้าสู่ระบบใหม่อีกครั้ง');
    const [user] = await this.db
      .select({ id: users.id, failed: users.failedLoginCount, lockedUntil: users.lockedUntil, disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, t.userId));
    if (!user || user.disabledAt) throw new AppError(401, 'mfa_token_invalid', 'ขั้นตอนยืนยันตัวตนหมดเวลา · เข้าสู่ระบบใหม่อีกครั้ง');
    this.login_.assertNotLocked(user);

    const check = await this.mfa.verify(this.db, user.id, input.code);
    if (!check) {
      const left = await this.login_.recordFailure(user, req, 'mfa');
      throw new AppError(401, 'invalid_mfa_code', 'รหัสยืนยันไม่ถูกต้อง', left);
    }
    await this.login_.resetFailures(user.id);
    const trustUntil = input.trustDevice ? new Date(Date.now() + authTimes.mfaTrustDays * 86_400_000) : null;
    await this.login_.startSession(user.id, t.remember, req, res, trustUntil);
    if (check.method === 'backup') {
      await this.security.audit(user.id, 'secu.backup_code_used', `เข้าสู่ระบบด้วย Backup code (เหลือ ${check.backupCodesLeft} รหัส)`, req);
      return { id: user.id, backupCodesLeft: check.backupCodesLeft };
    }
    return { id: user.id };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Auth() auth: AuthInfo, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(auth.sessionId);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  /** J3 · ตอบ 202 เสมอ ไม่บอกว่ามีบัญชีหรือไม่ · ขอซ้ำภายใน 60 วินาทีจะไม่ส่งใหม่ */
  @Public()
  @Post('password/forgot')
  @HttpCode(202)
  async forgot(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parse(EmailBody, body);
    const [user] = await this.db
      .select({ id: users.id, email: users.email, disabledAt: users.disabledAt })
      .from(users)
      .where(sql`lower(${users.email}) = ${input.email.toLowerCase()}`);
    if (user && !user.disabledAt && (await this.tokens.resendWait(user.id, 'reset_password')) === 0) {
      // J3 ใช้ลิงก์อย่างเดียว ไม่มีรหัส 6 หลัก
      const { token } = await this.tokens.issue(user.id, 'reset_password', authTimes.resetPasswordMinutes, undefined, false);
      await this.account.mail(user.email, 'ตั้งรหัสผ่านใหม่ · Friday Manage', [
        'กดลิงก์นี้เพื่อตั้งรหัสผ่านใหม่ (ใช้ได้ 30 นาที)',
        this.account.link('/forgot-password', token),
        'ถ้าไม่ได้ขอเอง ไม่ต้องทำอะไร รหัสผ่านเดิมยังใช้ได้',
      ]);
      devToken(res, { token });
    }
    return { retryAfter: authTimes.resendSeconds };
  }

  /** J3 ขั้นตั้งรหัสใหม่ · บอกอีเมลของลิงก์ ("ตั้งรหัสผ่านใหม่ สำหรับ …") โดยยังไม่ใช้ลิงก์ */
  @Public()
  @Get('password/reset')
  async resetInfo(@Query('token') token: string | undefined) {
    const row = token ? await this.tokens.peekLink(token, ['reset_password']) : null;
    if (!row) throw invalidToken();
    const [user] = await this.db.select({ email: users.email }).from(users).where(eq(users.id, row.userId));
    const policy = await this.security.policyFor(row.userId);
    return { email: user.email, expiresAt: row.expiresAt, policy: { minLength: policy.passwordMinLength, requireSpecial: policy.passwordRequireSpecial } };
  }

  /** ตั้งรหัสผ่านใหม่จากลิงก์ · logoutAll (ค่าเริ่มต้น) ออกจากระบบทุกเครื่อง · ส่งอีเมลแจ้ง */
  @Public()
  @Post('password/reset')
  @HttpCode(200)
  async reset(@Body() body: unknown, @Req() req: AppRequest) {
    const input = parse(ResetBody, body);
    const pending = await this.tokens.peekLink(input.token, ['reset_password']);
    if (!pending) throw invalidToken();
    // ตรวจรหัสใหม่ก่อนใช้ลิงก์ เพื่อให้แก้รหัสแล้วส่งใหม่ได้โดยไม่ต้องขอลิงก์ใหม่
    await this.security.assertPassword(pending.userId, input.newPassword, 'newPassword');
    const row = await this.tokens.consumeLink(input.token, ['reset_password']);
    if (!row) throw invalidToken();

    const passwordHash = await hash(input.newPassword);
    const [user] = await this.db
      .update(users)
      // กดลิงก์จากอีเมลได้ = เป็นเจ้าของอีเมล จึงถือว่ายืนยันอีเมลแล้ว
      .set({ passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null, emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
      .where(eq(users.id, row.userId))
      .returning({ id: users.id, email: users.email });
    await this.account.ensurePasswordIdentity(this.db, user.id);
    const loggedOut = input.logoutAll ? await this.sessions.revokeAll(user.id) : 0;
    await this.security.audit(user.id, 'secu.password_reset', `ตั้งรหัสผ่านใหม่จากลิงก์ลืมรหัสผ่าน${input.logoutAll ? ` · ออกจากระบบ ${loggedOut} อุปกรณ์` : ''}`, req);
    await this.account.mail(user.email, 'รหัสผ่านของคุณถูกเปลี่ยน · Friday Manage', [
      'รหัสผ่านของบัญชี Friday Manage ถูกเปลี่ยนเรียบร้อย',
      'ถ้าไม่ได้ทำเอง ให้ติดต่อ Admin ของ Workspace ทันที',
    ]);
    return { ok: true, email: user.email, loggedOutSessions: loggedOut };
  }

  private async sendVerifyEmail(userId: string, email: string, res: Response) {
    const { token, code } = await this.tokens.issue(userId, 'verify_email', authTimes.verifyEmailMinutes);
    await this.account.mail(email, `รหัสยืนยันอีเมล ${code} · Friday Manage`, [
      `รหัสยืนยันอีเมลของคุณคือ ${code}`,
      `หรือกดลิงก์นี้: ${this.account.link('/signup', token)}`,
    ]);
    devToken(res, { code, token });
  }

  private async markVerified(userId: string) {
    const [u] = await this.db
      .update(users)
      .set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
      .where(eq(users.id, userId))
      .returning({ email: users.email });
    return { emailVerified: true, email: u.email };
  }

  /** หาผู้ใช้จากอีเมล หรือจาก Session ถ้าไม่ได้ส่งอีเมลมา */
  private async findUser(email: string | undefined, req: AppRequest) {
    const where = email ? sql`lower(${users.email}) = ${email.toLowerCase()}` : req.auth ? eq(users.id, req.auth.userId) : null;
    if (!where) return null;
    const [u] = await this.db.select({ id: users.id, email: users.email, emailVerifiedAt: users.emailVerifiedAt }).from(users).where(where);
    return u ?? null;
  }
}
