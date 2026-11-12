import { Body, Controller, Get, HttpCode, Module, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { type OpsRequest, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { SupportModule } from '../support/support.module.js';
import { ChangelogService, EntryBody, HideBody } from './changelog.service.js';
import { FollowUpBody, NpsOpsService, ResponsesQuery, SettingsBody, SummaryQuery, TicketBody } from './nps.service.js';

/**
 * Changelog และ NPS (O33 · เมนู แพ็กเกจและการตลาด › Changelog และ NPS)
 * Changelog: ทุกบทบาทอ่านได้ · Owner เขียน / เผยแพร่ / ซ่อน (ยังไม่สร้างบทบาท "การตลาด" ตามคำตัดสิน)
 */
@Controller('ops/changelog')
export class ChangelogController {
  constructor(private readonly changelog: ChangelogService) {}

  @Get()
  list() {
    return this.changelog.list();
  }

  @Roles('owner')
  @Post()
  create(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.changelog.create(req.staff!, parse(EntryBody, body));
  }

  @Roles('owner')
  @Put(':id')
  update(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.changelog.update(req.staff!, id, parse(EntryBody, body));
  }

  @Roles('owner')
  @Post([':id/hide', ':id\\:hide'])
  @HttpCode(200)
  hide(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.changelog.hide(req.staff!, id, parse(HideBody, body));
  }
}

/**
 * NPS · ตัวเลขรวม: Owner / Support / การเงิน / ผู้ตรวจ · ความเห็นพร้อมชื่อ Workspace และการติดตาม: Owner / Support
 * ตั้งค่าแบบสำรวจ: อ่านได้ทุกคนที่เห็น NPS · แก้ได้เฉพาะ Owner
 */
@Controller('ops/nps')
export class NpsController {
  constructor(private readonly nps: NpsOpsService) {}

  @Roles('owner', 'support', 'finance', 'auditor')
  @Get('summary')
  summary(@Query() q: unknown) {
    return this.nps.summary(parse(SummaryQuery, q).range);
  }

  @Roles('owner', 'support')
  @Get('responses')
  list(@Query() q: unknown) {
    return this.nps.list(parse(ResponsesQuery, q));
  }

  @Roles('owner', 'support')
  @Get('responses/:id')
  detail(@Param('id') id: string) {
    return this.nps.detail(id);
  }

  @Roles('owner', 'support')
  @Patch('responses/:id')
  followUp(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.nps.followUp(req.staff!, id, parse(FollowUpBody, body));
  }

  @Roles('owner', 'support')
  @Post('responses/:id/ticket')
  @HttpCode(200)
  ticket(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.nps.openTicket(req.staff!, id, parse(TicketBody, body));
  }

  @Roles('owner', 'support', 'finance', 'auditor')
  @Get('settings')
  settings(@Req() req: OpsRequest) {
    return this.nps.settings(req.staff!);
  }

  @Roles('owner')
  @Put('settings')
  saveSettings(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.nps.saveSettings(req.staff!, parse(SettingsBody, body));
  }
}

@Module({ imports: [SupportModule], controllers: [ChangelogController, NpsController], providers: [ChangelogService, NpsOpsService] })
export class ChangelogModule {}
