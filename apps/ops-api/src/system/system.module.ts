import { Body, Controller, Get, HttpCode, Module, Param, Post, Req } from '@nestjs/common';
import { type OpsRequest, Public, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { JobQueue } from './job-queue.js';
import { DiscardBody, IncidentBody, IncidentUpdateBody, MaintenanceBody, RetryManyBody, SubscribeBody, SystemService, TokenBody } from './system.service.js';

/**
 * สถานะระบบ เหตุขัดข้อง ปิดปรับปรุง งานที่ล้ม (O04) · งานของวิศวกร (06 › 2)
 * Support เปิด / อัปเดตเหตุขัดข้องได้ด้วย เพราะเป็นคนรับเรื่องจากลูกค้าก่อน
 */
@Controller('ops')
export class SystemController {
  constructor(private readonly system: SystemService) {}

  @Roles('engineer', 'owner')
  @Get('system/status')
  status() {
    return this.system.status();
  }

  @Roles('engineer', 'support', 'owner')
  @Get('incidents')
  incidents() {
    return this.system.incidents();
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

@Module({ controllers: [SystemController, PublicStatusController], providers: [SystemService, JobQueue] })
export class SystemModule {}
