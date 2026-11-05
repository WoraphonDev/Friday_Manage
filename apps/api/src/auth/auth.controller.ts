import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
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
import { CSRF_COOKIE, hashToken, newToken, SESSION_COOKIE, SessionService } from './sessions.js';

const { users, userIdentities, authTokens } = schema;

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

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(SYSTEM_DB) private readonly db: Db,
    private readonly sessions: SessionService,
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
      // รหัสยืนยันอีเมล · การส่งอีเมลปิดไว้ช่วงแรก (docs/tech-stack.md) จึงยังไม่บังคับยืนยันก่อนใช้งาน
      await tx.insert(authTokens).values({
        userId: user.id,
        purpose: 'verify_email',
        tokenHash: hashToken(newToken()),
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      return user.id;
    });

    await this.startSession(userId, false, req, res);
    res.status(201);
    return { id: userId, email, displayName: input.displayName };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const input = parse(LoginBody, body);
    const [user] = await this.db
      .select({ id: users.id, passwordHash: users.passwordHash, failed: users.failedLoginCount, lockedUntil: users.lockedUntil, disabledAt: users.disabledAt })
      .from(users)
      .where(sql`lower(${users.email}) = ${input.email.toLowerCase()}`);

    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError(429, 'account_locked', 'บัญชีถูกล็อกชั่วคราวเพราะใส่รหัสผิดหลายครั้ง', { lockedUntil: user.lockedUntil });
    }
    const ok = !!user?.passwordHash && !user.disabledAt && (await verify(user.passwordHash, input.password));
    if (!ok) {
      if (user) {
        const failed = user.failed + 1;
        const lock = failed >= config.lockoutAttempts;
        await this.db
          .update(users)
          .set({ failedLoginCount: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + config.lockoutMinutes * 60_000) : null })
          .where(eq(users.id, user.id));
        // J1: "ลองได้อีก 4 ครั้งก่อนบัญชีถูกล็อก 15 นาที"
        throw new AppError(401, 'invalid_credentials', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง', { attemptsLeft: lock ? 0 : config.lockoutAttempts - failed });
      }
      throw new AppError(401, 'invalid_credentials', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    }

    await this.db.update(users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, user.id));
    // 2FA (J1 ขั้นที่ 2) ทำในรอบถัดไป: ถ้ามี mfa_factors ที่เปิดอยู่จะตอบ mfaRequired แทนการเปิด Session
    await this.startSession(user.id, input.remember, req, res);
    return { id: user.id };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Auth() auth: AuthInfo, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(auth.sessionId);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  private async startSession(userId: string, remember: boolean, req: AppRequest, res: Response) {
    const s = await this.sessions.create(userId, { userAgent: req.get('user-agent'), ip: req.ip, remember });
    res.cookie(SESSION_COOKIE, s.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      path: '/',
      ...(s.rememberUntil ? { expires: s.rememberUntil } : {}),
    });
  }
}
