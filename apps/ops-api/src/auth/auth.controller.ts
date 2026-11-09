import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { config } from '../config.js';
import { parse } from '../errors.js';
import { AuthService, EnrollBody, LoginOptionsBody, VerifyBody } from './auth.service.js';
import { effectiveRoles, type OpsRequest, Public, REAUTH_COOKIE, REAUTH_SECONDS } from './auth.guard.js';
import { legacyRole } from './roles.js';
import { verify } from './tokens.js';

@Controller('ops/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** เริ่มลงทะเบียน Security key · Public เพราะพนักงานใหม่ยังไม่มี session (ใช้ enrollToken) */
  @Public()
  @Post('register/options')
  @HttpCode(200)
  registerOptions(@Req() req: OpsRequest, @Body() body: unknown) {
    const b = parse(EnrollBody, body ?? {});
    // มี session อยู่ = เพิ่ม key สำรองของตัวเอง
    const session = verify<{ sid: string }>('ops-session', (req.cookies as Record<string, string> | undefined)?.[config.cookie]);
    return this.auth.registerOptions(session?.sid, b.enrollToken);
  }

  @Public()
  @Post('register/verify')
  @HttpCode(200)
  registerVerify(@Body() body: unknown) {
    return this.auth.registerVerify(parse(VerifyBody, body));
  }

  @Public()
  @Post('login/options')
  @HttpCode(200)
  loginOptions(@Body() body: unknown) {
    return this.auth.loginOptions(parse(LoginOptionsBody, body).email);
  }

  @Public()
  @Post('login/verify')
  @HttpCode(200)
  async loginVerify(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.loginVerify(parse(VerifyBody, body));
    res.cookie(config.cookie, r.token, { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, maxAge: config.sessionHours * 3_600_000, path: '/' });
    return { staff: { ...r.staff, role: legacyRole(r.staff.roles) } };
  }

  @Get('me')
  me(@Req() req: OpsRequest) {
    const st = req.staff!;
    return { staff: { id: st.id, email: st.email, name: st.name, role: legacyRole(st.roles), roles: st.roles, elevated: st.elevated, effectiveRoles: effectiveRoles(st), department: st.department, limits: st.limits }, reauthed: !!req.reauthed };
  }

  /** ยืนยันตัวตนซ้ำก่อนทำรายการเสี่ยง (G4) */
  @Post('reauth/options')
  @HttpCode(200)
  reauthOptions(@Req() req: OpsRequest) {
    return this.auth.reauthOptions(req.staff!.id);
  }

  @Post('reauth/verify')
  @HttpCode(200)
  async reauthVerify(@Req() req: OpsRequest, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.reauthVerify(req.staff!.id, parse(VerifyBody, body));
    res.cookie(REAUTH_COOKIE, r.token, { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, maxAge: REAUTH_SECONDS * 1000, path: '/' });
    return { reauthed: true, expiresInSeconds: r.expiresInSeconds };
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(config.cookie, { path: '/' });
    res.clearCookie(REAUTH_COOKIE, { path: '/' });
    return { ok: true };
  }
}
