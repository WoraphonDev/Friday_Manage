import { Body, Controller, Delete, Get, HttpCode, Module, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { type OpsRequest, Reauth, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { DigestService } from './digest.service.js';
import { AuditQuery, ElevateBody, InviteBody, PasswordPolicyBody, PersonalEmailBody, PersonalEmailVerifyBody, StaffService, StatusBody, UpdateStaffBody } from './staff.service.js';

@Controller('ops')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Roles('owner', 'auditor')
  @Get('staff')
  list(@Req() req: OpsRequest) {
    return this.staff.list(req.staff!);
  }

  /** ความยาวรหัสผ่านขั้นต่ำของพนักงาน Ops และลูกค้า (แบบ A · 19 พ.ย.) · อยู่หลังปุ่มเฟืองหน้าพนักงาน */
  @Roles('owner', 'auditor')
  @Get('staff/password-policy')
  passwordPolicy() {
    return this.staff.passwordPolicy();
  }
  @Roles('owner')
  @Put('staff/password-policy')
  savePasswordPolicy(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.staff.savePasswordPolicy(req.staff!, parse(PasswordPolicyBody, body));
  }

  /** อีเมลส่วนตัวของตัวเอง (H1) · ทุกบทบาท · แก้ได้เฉพาะเจ้าของบัญชีและต้องแตะกุญแจ */
  @Get('staff/me/personal-email')
  personalEmail(@Req() req: OpsRequest) {
    return this.staff.personalEmail(req.staff!);
  }
  @Reauth()
  @Post('staff/me/personal-email')
  @HttpCode(200)
  requestPersonalEmail(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.staff.requestPersonalEmail(req.staff!, parse(PersonalEmailBody, body));
  }
  @Post(['staff/me/personal-email/verify', 'staff/me/personal-email\\:verify'])
  @HttpCode(200)
  verifyPersonalEmail(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.staff.verifyPersonalEmail(req.staff!, parse(PersonalEmailVerifyBody, body));
  }

  @Roles('owner')
  @Post('staff')
  invite(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.staff.invite(req.staff!, !!req.reauthed, parse(InviteBody, body));
  }

  @Roles('owner')
  @Patch('staff/:id')
  update(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.staff.update(req.staff!, !!req.reauthed, id, parse(UpdateStaffBody, body));
  }

  @Roles('owner')
  @Post(['staff/:id/status', 'staff/:id\\:status'])
  @HttpCode(200)
  setStatus(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.staff.setStatus(req.staff!, id, parse(StatusBody, body));
  }

  @Roles('owner')
  @Post(['staff/:id/enroll-link', 'staff/:id\\:enroll-link'])
  @HttpCode(200)
  enrollLink(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.staff.enrollLink(req.staff!, id);
  }

  @Roles('owner')
  @Reauth()
  @Delete('staff/:id/keys/:credentialId')
  removeKey(@Req() req: OpsRequest, @Param('id') id: string, @Param('credentialId') credentialId: string) {
    return this.staff.removeKey(req.staff!, id, credentialId);
  }

  /** สิทธิ์ฉุกเฉินของตัวเอง (A12) */
  @Roles('owner')
  @Reauth()
  @Post('staff/me/elevations')
  elevate(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.staff.elevate(req.staff!, parse(ElevateBody, body));
  }

  @Post(['staff/me/elevations/:id/end', 'staff/me/elevations/:id\\:end'])
  @HttpCode(200)
  endElevation(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.staff.endElevation(req.staff!, id);
  }

  @Roles('owner', 'auditor')
  @Get('audit')
  audit(@Query() q: unknown) {
    return this.staff.auditLog(parse(AuditQuery, q));
  }
}

@Module({ controllers: [StaffController], providers: [StaffService, DigestService], exports: [DigestService] })
export class StaffModule {}
