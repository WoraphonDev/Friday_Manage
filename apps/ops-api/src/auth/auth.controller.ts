import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { config } from '../config.js';
import { parse } from '../errors.js';
import { PresenceService } from '../support/presence.service.js';
import { AuthService, EnrollBody, LoginOptionsBody, PasswordLoginBody, PasswordSetupBody, PasswordVerifyBody, TotpBody, TotpLoginBody, VerifyBody } from './auth.service.js';
import { effectiveRoles, type OpsRequest, Public, Reauth, REAUTH_COOKIE, REAUTH_SECONDS, reauthFresh, SESSION_PURPOSE } from './auth.guard.js';
import { legacyRole } from './roles.js';
import { verify } from './tokens.js';

@Controller('ops/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly presence: PresenceService,
  ) {}

  /** เริ่มลงทะเบียน Security key · Public เพราะพนักงานใหม่ยังไม่มี session (ใช้ enrollToken) */
  @Public()
  @Post('register/options')
  @HttpCode(200)
  registerOptions(@Req() req: OpsRequest, @Body() body: unknown) {
    const b = parse(EnrollBody, body ?? {});
    // มี session อยู่ = เพิ่ม key สำรองของตัวเอง
    const session = verify<{ sid: string }>(SESSION_PURPOSE, (req.cookies as Record<string, string> | undefined)?.[config.cookie]);
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
    return this.signedIn(res, await this.auth.loginVerify(parse(VerifyBody, body)));
  }

  /** ขั้นที่ 1 ของการเข้าด้วยรหัสผ่าน · ได้ mfaToken ไปใส่รหัส 6 หลัก */
  @Public()
  @Post('login/password')
  @HttpCode(200)
  loginPassword(@Body() body: unknown) {
    return this.auth.loginPassword(parse(PasswordLoginBody, body));
  }

  @Public()
  @Post('login/totp')
  @HttpCode(200)
  async loginTotp(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.signedIn(res, await this.auth.loginTotp(parse(TotpLoginBody, body)));
  }

  private signedIn(res: Response, r: { token: string; staff: { roles: string[] } & Record<string, unknown> }) {
    res.cookie(config.cookie, r.token, { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, maxAge: config.sessionHours * 3_600_000, path: '/' });
    return { staff: { ...r.staff, role: legacyRole(r.staff.roles as never) } };
  }

  /** ตั้งรหัสผ่าน + แอป Authenticator · Public เพราะพนักงานใหม่ยังไม่มี session (ใช้ enrollToken) · มี session ต้องยืนยันตัวตนซ้ำแล้ว */
  @Public()
  @Post('password/setup')
  @HttpCode(200)
  passwordSetup(@Req() req: OpsRequest, @Body() body: unknown) {
    const b = parse(PasswordSetupBody, body ?? {});
    const session = verify<{ sid: string }>(SESSION_PURPOSE, (req.cookies as Record<string, string> | undefined)?.[config.cookie]);
    return this.auth.passwordSetup(session ? { sid: session.sid, reauthed: reauthFresh(req, session.sid) } : undefined, b.enrollToken);
  }

  @Public()
  @Post('password/verify')
  @HttpCode(200)
  passwordVerify(@Body() body: unknown) {
    return this.auth.passwordVerify(parse(PasswordVerifyBody, body));
  }

  @Get('me')
  async me(@Req() req: OpsRequest) {
    const st = req.staff!;
    return {
      staff: { id: st.id, email: st.email, name: st.name, role: legacyRole(st.roles), roles: st.roles, elevated: st.elevated, effectiveRoles: effectiveRoles(st), department: st.department, limits: st.limits },
      reauthed: !!req.reauthed,
      methods: await this.auth.methods(st.id),
    };
  }

  /** ลบ Security key ของตัวเอง (เมนูบัญชี › วิธีเข้าระบบ) */
  @Reauth()
  @Delete('keys/:credentialId')
  removeKey(@Req() req: OpsRequest, @Param('credentialId') credentialId: string) {
    return this.auth.removeOwnKey(req.staff!, credentialId);
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
    return this.reauthed(res, await this.auth.reauthVerify(req.staff!.id, parse(VerifyBody, body)));
  }

  /** ยืนยันตัวตนซ้ำด้วยรหัส 6 หลักจากแอป (ใช้ได้ทุกเครื่อง) */
  @Post('reauth/totp')
  @HttpCode(200)
  async reauthTotp(@Req() req: OpsRequest, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.reauthed(res, await this.auth.reauthTotp(req.staff!.id, parse(TotpBody, body).code));
  }

  private reauthed(res: Response, r: { token: string; expiresInSeconds: number }) {
    res.cookie(REAUTH_COOKIE, r.token, { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, maxAge: REAUTH_SECONDS * 1000, path: '/' });
    return { reauthed: true, expiresInSeconds: r.expiresInSeconds };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: OpsRequest, @Res({ passthrough: true }) res: Response) {
    // S3 · พนักงาน Support ที่ออกจากระบบเป็นออฟไลน์อัตโนมัติ (ตั้งค่าได้) · เปลี่ยนไม่ได้ไม่ให้การออกจากระบบล้ม
    if (req.staff) await this.presence.loggedOut(req.staff).catch(() => undefined);
    res.clearCookie(config.cookie, { path: '/' });
    res.clearCookie(REAUTH_COOKIE, { path: '/' });
    return { ok: true };
  }
}
