import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { config } from '../config.js';
import { parse } from '../errors.js';
import { AuthService, EnrollBody, LoginOptionsBody, VerifyBody } from './auth.service.js';
import { type OpsRequest, Public } from './auth.guard.js';
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
    return { staff: r.staff };
  }

  @Get('me')
  me(@Req() req: OpsRequest) {
    return { staff: req.staff };
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(config.cookie, { path: '/' });
    return { ok: true };
  }
}
