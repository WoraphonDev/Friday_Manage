import { Body, Controller, Get, HttpCode, Module, Param, Post, Query, Req } from '@nestjs/common';
import { type OpsRequest, Reauth, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { ActionBody, ChangeEmailBody, CloseBody, ResetMfaBody, UsersQuery, UsersService } from './users.service.js';

/**
 * ผู้ใช้ทั้งระบบ (O02 · หน้า "ผู้ใช้ทั้งหมด") · ค้นได้เฉพาะ Owner / Support (มีอีเมลลูกค้า)
 * การกระทำเป็นงาน Support · เรื่องที่ยึดบัญชีได้ (2FA เปลี่ยนอีเมล ปิดบัญชี) ต้องแตะ Security key ซ้ำ (G4)
 */
@Controller('ops/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Roles('owner', 'support')
  @Get()
  list(@Query() q: unknown) {
    return this.users.list(parse(UsersQuery, q));
  }
  @Roles('owner', 'support')
  @Get(':id')
  get(@Param('id') id: string) {
    return this.users.get(id);
  }

  @Roles('support')
  @Post([':id/unlock', ':id\\:unlock'])
  @HttpCode(200)
  unlock(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.users.unlock(req.staff!, id, parse(ActionBody, body));
  }
  @Roles('support')
  @Post([':id/resend-verification', ':id\\:resend-verification'])
  @HttpCode(200)
  resend(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.users.resendVerification(req.staff!, id, parse(ActionBody, body));
  }
  @Roles('support')
  @Reauth()
  @Post([':id/reset-2fa', ':id\\:reset-2fa'])
  @HttpCode(200)
  resetMfa(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.users.resetMfa(req.staff!, id, parse(ResetMfaBody, body));
  }
  @Roles('support')
  @Reauth()
  @Post([':id/change-email', ':id\\:change-email'])
  @HttpCode(200)
  changeEmail(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.users.changeEmail(req.staff!, id, parse(ChangeEmailBody, body));
  }
  @Roles('support')
  @Post([':id/sign-out-all', ':id\\:sign-out-all'])
  @HttpCode(200)
  signOutAll(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.users.signOutAll(req.staff!, id, parse(ActionBody, body));
  }
  @Roles('support')
  @Reauth()
  @Post([':id/close', ':id\\:close'])
  @HttpCode(200)
  close(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.users.close(req.staff!, id, parse(CloseBody, body));
  }
}

/** O01 เตรียม module ไว้ใน app.module แล้ว · งานนี้เพิ่ม controller / provider */
@Module({ controllers: [UsersController], providers: [UsersService] })
export class UsersModule {}
