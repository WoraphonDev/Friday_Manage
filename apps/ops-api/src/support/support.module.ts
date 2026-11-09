import { Body, Controller, Get, HttpCode, Module, Param, Post, Req } from '@nestjs/common';
import { type OpsRequest, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { StartSessionBody, SupportService } from './support.service.js';

/** เข้าบัญชีลูกค้าเพื่อช่วยเหลือ (O04 เพิ่ม Ticket ใน module นี้) */
@Controller('ops')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Roles('support')
  @Post(['workspaces/:id/support-sessions'])
  startSession(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.support.start(req.staff!, id, parse(StartSessionBody, body));
  }
  @Roles('support', 'owner')
  @Get('support-sessions')
  openSessions() {
    return this.support.open();
  }
  @Roles('support', 'owner')
  @Post(['support-sessions/:id/end', 'support-sessions/:id\\:end'])
  @HttpCode(200)
  endSession(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.support.end(req.staff!, id);
  }
}

@Module({ controllers: [SupportController], providers: [SupportService] })
export class SupportModule {}
