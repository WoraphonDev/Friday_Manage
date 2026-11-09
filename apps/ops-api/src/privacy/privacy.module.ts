import { Body, Controller, Get, HttpCode, Module, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { type OpsRequest, Reauth, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { AdvanceBody, BreachBody, BreachMarkBody, BreachPatchBody, CreateRequestBody, EraseBody, PrivacyService, RejectBody, RequestsQuery, VerifyBody } from './privacy.service.js';

/**
 * คำขอ PDPA และเหตุละเมิดข้อมูล (O05 · หน้า Privacy · A3–A6)
 * คำขอ: Support รับเรื่อง · Owner (ผู้รับผิดชอบ DPO) ทำได้ทุกขั้น · ผู้ตรวจอ่านได้
 * เหตุละเมิด: Owner และวิศวกร (คนที่มักรู้เหตุก่อน) · ลบตามคำขอต้องแตะ key ซ้ำและมีคนที่สองอนุมัติ
 */
@Controller('ops/privacy')
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @Roles('owner', 'support', 'auditor')
  @Get('requests')
  list(@Query() q: unknown) {
    return this.privacy.list(parse(RequestsQuery, q));
  }
  @Roles('owner', 'support', 'auditor')
  @Get('requests/:id')
  get(@Param('id') id: string) {
    return this.privacy.get(id);
  }
  @Roles('owner', 'support')
  @Post('requests')
  create(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.privacy.create(req.staff!, parse(CreateRequestBody, body));
  }
  @Roles('owner', 'support')
  @Post(['requests/:id/verify', 'requests/:id\\:verify'])
  @HttpCode(200)
  verify(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.privacy.verify(req.staff!, id, parse(VerifyBody, body));
  }
  @Roles('owner', 'support')
  @Post(['requests/:id/advance', 'requests/:id\\:advance'])
  @HttpCode(200)
  advance(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.privacy.advance(req.staff!, id, parse(AdvanceBody, body));
  }
  @Roles('owner', 'support')
  @Post(['requests/:id/reject', 'requests/:id\\:reject'])
  @HttpCode(200)
  reject(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.privacy.reject(req.staff!, id, parse(RejectBody, body));
  }
  /** ต้องอนุมัติทุกครั้ง → 202 */
  @Roles('owner', 'support')
  @Reauth()
  @Post(['requests/:id/erase', 'requests/:id\\:erase'])
  @HttpCode(202)
  erase(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.privacy.requestErase(req.staff!, id, parse(EraseBody, body));
  }
  @Roles('owner', 'support', 'auditor')
  @Get('pending-deletes')
  pendingDeletes() {
    return this.privacy.pendingDeletes();
  }

  @Roles('owner', 'engineer', 'auditor')
  @Get('breaches')
  breaches() {
    return this.privacy.breaches();
  }
  @Roles('owner', 'engineer', 'auditor')
  @Get('breaches/:id')
  breach(@Param('id') id: string) {
    return this.privacy.getBreach(id);
  }
  @Roles('owner', 'engineer')
  @Post('breaches')
  openBreach(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.privacy.openBreach(req.staff!, parse(BreachBody, body));
  }
  @Roles('owner', 'engineer')
  @Patch('breaches/:id')
  updateBreach(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.privacy.updateBreach(req.staff!, id, parse(BreachPatchBody, body));
  }
  @Roles('owner')
  @Post(['breaches/:id/pdpc-notified', 'breaches/:id\\:pdpc-notified'])
  @HttpCode(200)
  pdpc(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.privacy.markPdpc(req.staff!, id, parse(BreachMarkBody, body));
  }
  @Roles('owner')
  @Post(['breaches/:id/subjects-notified', 'breaches/:id\\:subjects-notified'])
  @HttpCode(200)
  subjects(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.privacy.markSubjects(req.staff!, id, parse(BreachMarkBody, body));
  }
  @Roles('owner')
  @Post(['breaches/:id/close', 'breaches/:id\\:close'])
  @HttpCode(200)
  close(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.privacy.closeBreach(req.staff!, id, parse(BreachMarkBody, body));
  }
  @Roles('owner', 'engineer')
  @Get('breaches/:id/pdpc-draft')
  draft(@Param('id') id: string) {
    return this.privacy.pdpcDraft(id);
  }
}

@Module({ controllers: [PrivacyController], providers: [PrivacyService] })
export class PrivacyModule {}
