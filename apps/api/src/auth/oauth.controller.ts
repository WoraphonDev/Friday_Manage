import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq, sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { AppError } from '../common/errors.js';
import { type AppRequest, Public } from '../common/request.js';
import { config } from '../config.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { apiPublicUrl, authTimes, type OAuthProvider, oauthProvider, webUrl } from './auth.config.js';
import { pkceChallenge, signToken, verifyToken } from './crypto.js';
import { LoginService } from './login.service.js';
import { SecurityService } from './security.service.js';
import { newToken } from './sessions.js';

const { users, userIdentities } = schema;

export const OAUTH_COOKIE = 'fm_oauth';

interface OAuthState {
  p: string;
  s: string;
  v: string;
  m: 'login' | 'link';
  u?: string;
  r: boolean;
  n: string;
}

const UserInfo = z.object({
  sub: z.string().min(1).max(255),
  email: z.email().max(254),
  email_verified: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
  name: z.string().max(200).optional(),
});

/** next ต้องเป็น path ภายในเว็บเท่านั้น (กัน open redirect) */
const safeNext = (next: unknown) => (typeof next === 'string' && /^\/(?![/\\])[^\s]*$/.test(next) ? next : '/');

class OAuthFail extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * J1 / J2 / I · เข้าสู่ระบบด้วย Google และ Microsoft (OAuth 2.0 Authorization Code + PKCE S256)
 * state และ code_verifier อยู่ในคุกกี้ httpOnly ที่ลงลายมือชื่อ อายุ 10 นาที · ข้อมูลผู้ใช้อ่านจาก userinfo ของ OIDC
 * ใช้ friday_system เพราะยังไม่รู้ว่าเป็นใคร (หาจาก provider_subject / อีเมล)
 */
@Controller('auth/oauth')
export class OAuthController {
  constructor(
    @Inject(SYSTEM_DB) private readonly db: Db,
    private readonly login: LoginService,
    private readonly security: SecurityService,
  ) {}

  /** ?next=/w/... กลับไปหน้าเดิม · ?remember=true จำ 30 วัน · ?mode=link ผูกกับบัญชีที่ล็อกอินอยู่ (หน้า Profile) */
  @Public()
  @Get(':provider/start')
  start(
    @Param('provider') name: string,
    @Query() q: Record<string, string | undefined>,
    @Req() req: AppRequest,
    @Res() res: Response,
  ) {
    const p = this.provider(name);
    const mode = q.mode === 'link' ? 'link' : 'login';
    if (mode === 'link' && !req.auth) throw new AppError(401, 'unauthenticated', 'กรุณาเข้าสู่ระบบ');
    const state: OAuthState = { p: p.name, s: newToken(), v: newToken(), m: mode, u: req.auth?.userId, r: q.remember === 'true', n: safeNext(q.next) };
    res.cookie(OAUTH_COOKIE, signToken('oauth', { ...state }, authTimes.oauthStateMinutes * 60), {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      path: '/',
      maxAge: authTimes.oauthStateMinutes * 60_000,
    });
    const url = new URL(p.authorizeUrl);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: p.clientId,
      redirect_uri: this.redirectUri(p),
      scope: p.scope,
      state: state.s,
      code_challenge: pkceChallenge(state.v),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    res.redirect(302, url.toString());
  }

  /** provider ส่งกลับมาที่นี่ · ผลลัพธ์ทุกกรณี redirect ไปหน้าเว็บ (error อยู่ใน ?error=) */
  @Public()
  @Get(':provider/callback')
  async callback(@Param('provider') name: string, @Query() q: Record<string, string | undefined>, @Req() req: AppRequest, @Res() res: Response) {
    const p = this.provider(name);
    const state = verifyToken<OAuthState & Record<string, unknown>>('oauth', req.cookies?.[OAUTH_COOKIE]);
    res.clearCookie(OAUTH_COOKIE, { path: '/' });
    const fail = (code: string) => {
      const to = new URL(`${webUrl()}${state?.m === 'link' ? state.n : '/login'}`);
      to.searchParams.set('error', code);
      res.redirect(302, to.toString());
    };

    try {
      if (!state || state.p !== p.name || !q.state || q.state !== state.s) throw new OAuthFail('oauth_state_mismatch');
      if (q.error || !q.code) throw new OAuthFail('oauth_cancelled');
      const info = await this.fetchUserInfo(p, q.code, state.v);

      if (state.m === 'link') {
        // ต้องเป็นคนเดิมที่กดผูกจากหน้า Profile
        if (!req.auth || req.auth.userId !== state.u) throw new OAuthFail('oauth_session_changed');
        await this.linkIdentity(req.auth.userId, p.name, info.sub, req);
        const to = new URL(`${webUrl()}${state.n}`);
        to.searchParams.set('linked', p.name);
        return res.redirect(302, to.toString());
      }

      const user = await this.resolveUser(p.name, info, req);
      const result = await this.login.complete(user, state.r, req, res);
      if ('mfaRequired' in result) {
        // ส่ง mfaToken ใน fragment (#) ซึ่งเบราว์เซอร์ไม่ส่งต่อให้เซิร์ฟเวอร์และไม่ติดใน log
        const frag = new URLSearchParams({ mfaToken: result.mfaToken, email: result.email, next: state.n });
        return res.redirect(302, `${webUrl()}/login#${frag.toString()}`);
      }
      return res.redirect(302, `${webUrl()}${state.n}`);
    } catch (e) {
      if (e instanceof OAuthFail) return fail(e.code);
      throw e;
    }
  }

  private provider(name: string): OAuthProvider {
    const p = oauthProvider(name);
    if (!p) throw new AppError(404, 'oauth_provider_unavailable', 'ยังไม่เปิดให้เข้าสู่ระบบด้วยบริการนี้', { provider: name });
    return p;
  }

  private redirectUri = (p: OAuthProvider) => `${apiPublicUrl()}/api/v1/auth/oauth/${p.name}/callback`;

  /** แลก code เป็น access token (ส่ง code_verifier ตาม PKCE) แล้วอ่าน userinfo */
  private async fetchUserInfo(p: OAuthProvider, code: string, verifier: string) {
    try {
      const tokenRes = await fetch(p.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.redirectUri(p),
          client_id: p.clientId,
          client_secret: p.clientSecret,
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!tokenRes.ok) throw new OAuthFail('oauth_failed');
      const { access_token } = (await tokenRes.json()) as { access_token?: string };
      if (!access_token) throw new OAuthFail('oauth_failed');
      const infoRes = await fetch(p.userinfoUrl, { headers: { authorization: `Bearer ${access_token}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!infoRes.ok) throw new OAuthFail('oauth_failed');
      const parsed = UserInfo.safeParse(await infoRes.json());
      if (!parsed.success) throw new OAuthFail('oauth_email_missing');
      const v = parsed.data.email_verified;
      return { ...parsed.data, email: parsed.data.email.toLowerCase(), emailVerified: v === undefined ? null : v === true || v === 'true' };
    } catch (e) {
      if (e instanceof OAuthFail) throw e;
      throw new OAuthFail('oauth_failed');
    }
  }

  /**
   * บัญชีของผู้ที่ล็อกอินด้วย provider: เคยผูกแล้ว → บัญชีนั้น · อีเมลตรงบัญชีเดิม → ผูกเพิ่ม · ไม่มี → สมัครให้
   * provider ที่บอกชัดว่าอีเมลยังไม่ยืนยัน (email_verified = false) ห้ามผูกกับบัญชีเดิม กันการยึดบัญชีด้วยอีเมลปลอม
   */
  private async resolveUser(provider: OAuthProvider['name'], info: { sub: string; email: string; emailVerified: boolean | null; name?: string }, req: AppRequest) {
    const cols = { id: users.id, email: users.email, disabledAt: users.disabledAt };
    const [byIdentity] = await this.db
      .select(cols)
      .from(userIdentities)
      .innerJoin(users, eq(users.id, userIdentities.userId))
      .where(and(eq(userIdentities.provider, provider), eq(userIdentities.providerSubject, info.sub)));
    let user = byIdentity;

    if (!user) {
      const [byEmail] = await this.db.select(cols).from(users).where(sql`lower(${users.email}) = ${info.email}`);
      if (byEmail) {
        if (info.emailVerified === false) throw new OAuthFail('oauth_email_unverified');
        await this.linkIdentity(byEmail.id, provider, info.sub, req);
        await this.db.update(users).set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` }).where(eq(users.id, byEmail.id));
        user = byEmail;
      } else {
        user = await this.db.transaction(async (tx) => {
          const [u] = await tx
            .insert(users)
            .values({ email: info.email, displayName: (info.name?.trim() || info.email.split('@')[0]).slice(0, 80), emailVerifiedAt: info.emailVerified === false ? null : new Date() })
            .returning(cols);
          await tx.insert(userIdentities).values({ userId: u.id, provider, providerSubject: info.sub });
          return u;
        });
      }
    }
    if (user.disabledAt) throw new OAuthFail('account_disabled');
    return user;
  }

  private async linkIdentity(userId: string, provider: OAuthProvider['name'], sub: string, req: AppRequest) {
    const [existing] = await this.db
      .select({ userId: userIdentities.userId })
      .from(userIdentities)
      .where(and(eq(userIdentities.provider, provider), eq(userIdentities.providerSubject, sub)));
    if (existing) {
      if (existing.userId !== userId) throw new OAuthFail('identity_in_use');
      return;
    }
    await this.db.insert(userIdentities).values({ userId, provider, providerSubject: sub });
    await this.security.audit(userId, 'secu.identity_linked', `ผูกการเข้าสู่ระบบด้วย ${provider === 'google' ? 'Google' : 'Microsoft'}`, req);
  }
}
