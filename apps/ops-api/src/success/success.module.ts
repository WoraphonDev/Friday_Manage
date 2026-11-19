import { Body, Controller, Get, HttpCode, Module, Param, Post, Put, Query, Req } from '@nestjs/common';
import { type OpsRequest, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { PlaybookBody } from './playbooks.js';
import { CloseBody, OutcomeBody, RunsQuery, SnoozeBody, StartBody, SuccessService } from './success.service.js';

/** สุขภาพและ Playbook (O53) · Owner และ Support · แก้ Playbook ได้เฉพาะ Owner */
@Controller('ops/success')
export class SuccessController {
  constructor(private readonly success: SuccessService) {}

  @Roles('owner', 'support')
  @Get('summary')
  summary(@Req() req: OpsRequest) {
    return this.success.summary(req.staff!);
  }
  @Roles('owner', 'support')
  @Get('runs')
  runs(@Req() req: OpsRequest, @Query() q: unknown) {
    return this.success.runs(req.staff!, parse(RunsQuery, q));
  }
  @Roles('owner', 'support')
  @Get('runs/:id')
  detail(@Param('id') id: string) {
    return this.success.detail(id);
  }
  @Roles('owner', 'support')
  @Post('runs')
  start(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.success.start(req.staff!, parse(StartBody, body));
  }
  @Roles('owner', 'support')
  @Post('runs/:id/close')
  @HttpCode(200)
  close(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.success.close(req.staff!, id, parse(CloseBody, body).reason);
  }
  @Roles('owner', 'support')
  @Post('steps/:id/outcome')
  @HttpCode(200)
  outcome(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.success.recordOutcome(req.staff!, id, parse(OutcomeBody, body));
  }
  @Roles('owner', 'support')
  @Post('steps/:id/snooze')
  @HttpCode(200)
  snooze(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.success.snooze(req.staff!, id, parse(SnoozeBody, body).days);
  }
  /** รันรอบเช้าเดี๋ยวนี้ (เครื่องที่ปิดงานเบื้องหลัง OPS_JOBS=off หรือหลังแก้ Playbook) · ทุกขั้นรันซ้ำได้ */
  @Roles('owner')
  @Post('run')
  @HttpCode(200)
  run() {
    return this.success.daily();
  }
  @Roles('owner', 'support')
  @Get('playbooks')
  playbooks() {
    return this.success.playbooks();
  }
  @Roles('owner')
  @Put('playbooks/:id')
  save(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.success.savePlaybook(req.staff!, id, parse(PlaybookBody, body));
  }
}

@Module({ controllers: [SuccessController], providers: [SuccessService], exports: [SuccessService] })
export class SuccessModule {}
