import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { type OpsRequest, Roles } from './auth/auth.guard.js';
import { parse } from './errors.js';
import { AnnouncementBody, FlagBody, FlagsService, OverrideBody, PatchAnnouncementBody, PatchFlagBody } from './flags/flags.service.js';
import { MetricsService } from './metrics.service.js';
import { ConfirmBody, OpsPaymentsService, PaymentsQuery, RejectBody } from './payments/ops-payments.service.js';
import { StartSessionBody, SupportService } from './support/support.service.js';
import { ChangePlanBody, DiscountBody, ExtendTrialBody, ListQuery, SuspendBody, WorkspacesService } from './workspaces/workspaces.service.js';

const stream = (res: Response, f: { stream: NodeJS.ReadableStream; size: number; filename: string }) => {
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(f.size), 'Content-Disposition': `attachment; filename="${f.filename}"`, 'Cache-Control': 'private, no-store' });
  return new StreamableFile(f.stream as never);
};

/**
 * หลังบ้านทีม Friday (03-api › 3.12) · บทบาท: `admin` ทำได้ทุกอย่าง · `support` = ดูลูกค้า + เข้าช่วยเหลือ + ต่อช่วงทดลอง · `finance` = ชำระเงิน + ส่วนลด + แพ็กเกจ
 * ทุกข้อรับ session จาก Security key (global guard) ยกเว้น `ops/auth/*`
 */
@Controller('ops')
export class OpsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly workspaces: WorkspacesService,
    private readonly support: SupportService,
    private readonly payments: OpsPaymentsService,
    private readonly flags: FlagsService,
  ) {}

  @Get('metrics')
  getMetrics() {
    return this.metrics.get();
  }

  // Workspace ------------------------------------------------------------------
  @Get('workspaces')
  list(@Query() q: unknown) {
    return this.workspaces.list(parse(ListQuery, q));
  }
  @Get('workspaces/:id')
  get(@Param('id') id: string) {
    return this.workspaces.get(id);
  }

  @Roles('support')
  @Post(['workspaces/:id/support-sessions'])
  startSession(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.support.start(req.staff!, id, parse(StartSessionBody, body));
  }
  @Roles('support')
  @Get('support-sessions')
  openSessions() {
    return this.support.open();
  }
  @Roles('support')
  @Post(['support-sessions/:id/end', 'support-sessions/:id\\:end'])
  @HttpCode(200)
  endSession(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.support.end(req.staff!, id);
  }

  @Roles('support')
  @Post(['workspaces/:id/extend-trial', 'workspaces/:id\\:extend-trial'])
  @HttpCode(200)
  extendTrial(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.workspaces.extendTrial(req.staff!, id, parse(ExtendTrialBody, body));
  }
  @Roles('finance')
  @Post(['workspaces/:id/discount', 'workspaces/:id\\:discount'])
  @HttpCode(200)
  discount(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.workspaces.discount(req.staff!, id, parse(DiscountBody, body));
  }
  @Roles('finance')
  @Post(['workspaces/:id/change-plan', 'workspaces/:id\\:change-plan'])
  @HttpCode(200)
  changePlan(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.workspaces.changePlan(req.staff!, id, parse(ChangePlanBody, body));
  }
  @Roles()
  @Post(['workspaces/:id/suspend', 'workspaces/:id\\:suspend'])
  @HttpCode(200)
  suspend(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.workspaces.suspend(req.staff!, id, parse(SuspendBody, body));
  }
  @Roles()
  @Post(['workspaces/:id/resume', 'workspaces/:id\\:resume'])
  @HttpCode(200)
  resume(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.workspaces.resume(req.staff!, id, parse(SuspendBody, body));
  }

  // ชำระเงิน -------------------------------------------------------------------
  @Roles('finance')
  @Get('payments')
  listPayments(@Query() q: unknown) {
    return this.payments.list(parse(PaymentsQuery, q));
  }
  @Roles('finance')
  @Get('payments/:id/slip')
  async slip(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return stream(res, await this.payments.slip(id));
  }
  @Roles('finance')
  @Post(['payments/:id/confirm', 'payments/:id\\:confirm'])
  @HttpCode(200)
  confirm(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.payments.confirm(req.staff!, id, parse(ConfirmBody, body ?? {}));
  }
  @Roles('finance')
  @Post(['payments/:id/reject', 'payments/:id\\:reject'])
  @HttpCode(200)
  reject(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.payments.reject(req.staff!, id, parse(RejectBody, body));
  }
  @Roles('finance')
  @Get('wht-certificates/:id/file')
  async whtFile(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return stream(res, await this.payments.whtFile(id));
  }
  @Roles('finance')
  @Post(['wht-certificates/:id/confirm', 'wht-certificates/:id\\:confirm'])
  @HttpCode(200)
  confirmWht(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.payments.reviewWht(req.staff!, id, 'confirmed', parse(ConfirmBody, body ?? {}).note);
  }
  @Roles('finance')
  @Post(['wht-certificates/:id/reject', 'wht-certificates/:id\\:reject'])
  @HttpCode(200)
  rejectWht(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.payments.reviewWht(req.staff!, id, 'rejected', parse(RejectBody, body).reason);
  }

  // Feature flag / ประกาศ (admin) ----------------------------------------------
  @Roles()
  @Get('feature-flags')
  listFlags() {
    return this.flags.listFlags();
  }
  @Roles()
  @Post('feature-flags')
  createFlag(@Body() body: unknown) {
    return this.flags.createFlag(parse(FlagBody, body));
  }
  @Roles()
  @Patch('feature-flags/:id')
  patchFlag(@Param('id') id: string, @Body() body: unknown) {
    return this.flags.patchFlag(id, parse(PatchFlagBody, body));
  }
  @Roles()
  @Delete('feature-flags/:id')
  deleteFlag(@Param('id') id: string) {
    return this.flags.deleteFlag(id);
  }
  @Roles()
  @Put('feature-flags/:id/overrides/:workspaceId')
  setOverride(@Req() req: OpsRequest, @Param('id') id: string, @Param('workspaceId') ws: string, @Body() body: unknown) {
    return this.flags.setOverride(req.staff!, id, ws, parse(OverrideBody, body));
  }
  @Roles()
  @Delete('feature-flags/:id/overrides/:workspaceId')
  removeOverride(@Req() req: OpsRequest, @Param('id') id: string, @Param('workspaceId') ws: string) {
    return this.flags.removeOverride(req.staff!, id, ws);
  }

  @Roles()
  @Get('announcements')
  listAnnouncements() {
    return this.flags.listAnnouncements();
  }
  @Roles()
  @Post('announcements')
  createAnnouncement(@Body() body: unknown) {
    return this.flags.createAnnouncement(parse(AnnouncementBody, body));
  }
  @Roles()
  @Patch('announcements/:id')
  patchAnnouncement(@Param('id') id: string, @Body() body: unknown) {
    return this.flags.patchAnnouncement(id, parse(PatchAnnouncementBody, body));
  }
  @Roles()
  @Delete('announcements/:id')
  deleteAnnouncement(@Param('id') id: string) {
    return this.flags.deleteAnnouncement(id);
  }
  @Roles()
  @Post(['announcements/:id/publish', 'announcements/:id\\:publish'])
  @HttpCode(200)
  publish(@Param('id') id: string) {
    return this.flags.publishAnnouncement(id);
  }
}
