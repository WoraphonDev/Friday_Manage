import { Body, Controller, Get, HttpCode, Module, Param, Post, Put, Query, Req } from '@nestjs/common';
import { type OpsRequest, Public, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { PageQuery } from '../paging.js';
import { AlertSettings, AlertsService } from './alerts.service.js';
import { JobQueue } from './job-queue.js';
import { DiscardBody, IncidentBody, IncidentUpdateBody, MaintenanceBody, RetryManyBody, SubscribeBody, SystemService, TokenBody } from './system.service.js';

/**
 * สถานะระบบ เหตุขัดข้อง ปิดปรับปรุง งานที่ล้ม (O04) · งานของวิศวกร (06 › 2)
 * Support เปิด / อัปเดตเหตุขัดข้องได้ด้วย เพราะเป็นคนรับเรื่องจากลูกค้าก่อน
 */
@Controller('ops')
export class SystemController {
  constructor(
    private readonly system: SystemService,
    private readonly alerts: AlertsService,
  ) {}

  @Roles('engineer', 'owner')
  @Get('system/status')
  status() {
    return this.system.status();
  }

  /** เกณฑ์แจ้งเตือน Error rate (S11) · Owner / วิศวกร */
  @Roles('engineer', 'owner')
  @Get('system/alert-settings')
  alertSettings() {
    return this.alerts.settings().then((settings) => ({ settings }));
  }
  @Roles('engineer', 'owner')
  @Put('system/alert-settings')
  saveAlertSettings(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.alerts.saveSettings(req.staff!, parse(AlertSettings, body));
  }
  /** การแจ้งเตือนของระบบ (หน้าเหตุขัดข้องบนมือถือ · S12) */
  @Roles('engineer', 'support', 'owner')
  @Get('system/alerts')
  alertList() {
    return this.alerts.list();
  }
  /** "รับทราบ · ฉันดูอยู่" = คนที่ได้รับแจ้ง (วิศวกร / Owner) */
  @Roles('engineer', 'owner')
  @Post(['system/alerts/:id/acknowledge', 'system/alerts/:id\\:acknowledge'])
  @HttpCode(200)
  acknowledge(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.alerts.acknowledge(req.staff!, id);
  }
  /** เปิดเหตุขัดข้องภายในจากการแจ้งเตือน · สิทธิ์เดียวกับเปิดเหตุขัดข้อง */
  @Roles('engineer', 'support')
  @Post('system/alerts/:id/incident')
  openAlertIncident(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.alerts.openIncident(req.staff!, id);
  }

  @Roles('engineer', 'support', 'owner')
  @Get('incidents')
  incidents(@Query() q: unknown) {
    return this.system.incidents(parse(PageQuery, q));
  }
  @Roles('engineer', 'support')
  @Post('incidents')
  open(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.system.openIncident(req.staff!, parse(IncidentBody, body));
  }
  @Roles('engineer', 'support')
  @Post('incidents/:id/updates')
  update(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.system.updateIncident(req.staff!, id, parse(IncidentUpdateBody, body));
  }

  @Roles('engineer', 'owner')
  @Get('maintenance')
  maintenance() {
    return this.system.maintenance();
  }
  /** ต้องอนุมัติทุกครั้ง → 202 */
  @Roles('engineer')
  @Post('maintenance')
  @HttpCode(202)
  requestMaintenance(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.system.requestMaintenance(req.staff!, parse(MaintenanceBody, body));
  }
  @Roles('engineer', 'owner')
  @Post(['maintenance/:id/end', 'maintenance/:id\\:end'])
  @HttpCode(200)
  endMaintenance(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.system.endMaintenance(req.staff!, id);
  }

  @Roles('engineer')
  @Get('jobs/failed')
  failed() {
    return this.system.failedJobs();
  }
  @Roles('engineer')
  @Post('jobs/retry')
  @HttpCode(200)
  retryMany(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.system.retryMany(req.staff!, parse(RetryManyBody, body).ids);
  }
  @Roles('engineer')
  @Post(['jobs/:id/retry', 'jobs/:id\\:retry'])
  @HttpCode(200)
  retry(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.system.retryJob(req.staff!, id);
  }
  @Roles('engineer')
  @Post(['jobs/:id/discard', 'jobs/:id\\:discard'])
  @HttpCode(200)
  discard(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.system.discardJob(req.staff!, id, parse(DiscardBody, body));
  }
}

/**
 * หน้าสถานะสาธารณะ (status.fridaymanage.com) · ไม่ต้องล็อกอิน · ข้อมูลเฉพาะที่ลูกค้าเห็นได้
 * หมายเหตุ: AuthGuard ตรวจ Origin ของคำขอเขียน หน้าสถานะต้องอยู่ origin เดียวกับ OPS_WEB_ORIGIN หรือส่งผ่าน server
 */
@Controller('status')
export class PublicStatusController {
  constructor(private readonly system: SystemService) {}

  @Public()
  @Get()
  status() {
    return this.system.publicStatus();
  }
  @Public()
  @Post('subscribe')
  @HttpCode(200)
  subscribe(@Body() body: unknown) {
    return this.system.subscribe(parse(SubscribeBody, body));
  }
  @Public()
  @Post('confirm')
  @HttpCode(200)
  confirm(@Body() body: unknown) {
    return this.system.confirmSubscription(parse(TokenBody, body));
  }
  @Public()
  @Post('unsubscribe')
  @HttpCode(200)
  unsubscribe(@Body() body: unknown) {
    return this.system.unsubscribe(parse(SubscribeBody, body));
  }
}

@Module({ controllers: [SystemController, PublicStatusController], providers: [SystemService, AlertsService, JobQueue] })
export class SystemModule {}
