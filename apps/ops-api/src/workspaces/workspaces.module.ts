import { Body, Controller, Get, HttpCode, Module, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { type OpsRequest, Reauth, Roles } from '../auth/auth.guard.js';
import { BillingModule } from '../billing/billing.module.js';
import { parse } from '../errors.js';
import { AuditQuery, CustomersService, ListQuery } from './customers.service.js';
import { AccessRequestBody, ChangePlanBody, DiscountBody, ExtendTrialBody, type Gated, NoteBody, PreviewQuery, ResumeBody, SuspendBody, TransferOwnerBody, WorkspacesService } from './workspaces.service.js';

/** เกินวงเงิน → 202 พร้อมคำขออนุมัติ · ไม่เกิน → 200 พร้อมผล */
async function respond<T extends object>(res: Response, p: Promise<Gated<T>>) {
  const r = await p;
  if ('pendingApproval' in r) res.status(202);
  return r;
}

/**
 * Workspace ของลูกค้า (O02) · อ่านได้ทุกบทบาท แต่ตัดยอดเงิน / อีเมลตามบทบาทใน CustomersService
 * แท็บรายละเอียด: ภาพรวม = `GET :id` · ที่เหลือ = `GET :id/{usage|projects|members|integrations|security|billing|support|audit}`
 */
@Controller('ops')
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly customers: CustomersService,
  ) {}

  @Get('workspaces')
  list(@Req() req: OpsRequest, @Query() q: unknown) {
    return this.customers.list(req.staff!, parse(ListQuery, q));
  }
  @Get('workspaces/:id')
  get(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.customers.overview(req.staff!, id);
  }
  @Get('workspaces/:id/usage')
  usage(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.customers.usage(req.staff!, id);
  }
  @Get('workspaces/:id/projects')
  projects(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.customers.projects(req.staff!, id);
  }
  @Get('workspaces/:id/members')
  members(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.customers.members(req.staff!, id);
  }
  @Get('workspaces/:id/integrations')
  integrations(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.customers.integrations(req.staff!, id);
  }
  @Get('workspaces/:id/security')
  security(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.customers.security(req.staff!, id);
  }
  /** วิศวกรไม่เห็นข้อมูลเงิน · Support เห็นแค่สถานะ (ตัดใน service) */
  @Roles('owner', 'finance', 'support', 'auditor')
  @Get('workspaces/:id/billing')
  billing(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.customers.billing(req.staff!, id);
  }
  @Get('workspaces/:id/support')
  support(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.customers.support(req.staff!, id);
  }
  @Roles('owner', 'finance', 'support', 'auditor')
  @Get('workspaces/:id/audit')
  audit(@Req() req: OpsRequest, @Param('id') id: string, @Query() q: unknown) {
    return this.customers.audit(req.staff!, id, parse(AuditQuery, q));
  }

  @Roles('owner', 'finance', 'support')
  @Post('workspaces/:id/notes')
  note(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.workspaces.addNote(req.staff!, id, parse(NoteBody, body));
  }

  @Roles('support')
  @Post(['workspaces/:id/extend-trial', 'workspaces/:id\\:extend-trial'])
  @HttpCode(200)
  extendTrial(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return respond(res, this.workspaces.extendTrial(req.staff!, id, parse(ExtendTrialBody, body)));
  }
  @Roles('finance')
  @Post(['workspaces/:id/discount', 'workspaces/:id\\:discount'])
  @HttpCode(200)
  discount(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return respond(res, this.workspaces.discount(req.staff!, id, parse(DiscountBody, body)));
  }
  @Roles('finance')
  @Get('workspaces/:id/change-plan/preview')
  preview(@Param('id') id: string, @Query() q: unknown) {
    return this.workspaces.preview(id, parse(PreviewQuery, q));
  }
  @Roles('finance')
  @Post(['workspaces/:id/change-plan', 'workspaces/:id\\:change-plan'])
  @HttpCode(200)
  changePlan(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.workspaces.changePlan(req.staff!, id, parse(ChangePlanBody, body));
  }
  @Roles('owner', 'finance')
  @Post(['workspaces/:id/suspend', 'workspaces/:id\\:suspend'])
  @HttpCode(200)
  suspend(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return respond(res, this.workspaces.suspend(req.staff!, id, parse(SuspendBody, body)));
  }
  @Roles('owner', 'finance')
  @Post(['workspaces/:id/resume', 'workspaces/:id\\:resume'])
  @HttpCode(200)
  resume(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.workspaces.resume(req.staff!, id, parse(ResumeBody, body));
  }
  /** C7 · ต้องอนุมัติทุกครั้งจึงตอบ 202 เสมอ */
  @Roles('owner', 'support')
  @Reauth()
  @Post(['workspaces/:id/transfer-owner', 'workspaces/:id\\:transfer-owner'])
  @HttpCode(202)
  transferOwner(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.workspaces.transferOwner(req.staff!, id, parse(TransferOwnerBody, body));
  }
  /** C2 · ลูกค้ายังไม่เปิดสิทธิ์ให้เข้าบัญชี */
  @Roles('support')
  @Post(['workspaces/:id/support-access-request', 'workspaces/:id\\:request-access'])
  @HttpCode(200)
  requestAccess(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.workspaces.requestAccess(req.staff!, id, parse(AccessRequestBody, body));
  }
}

@Module({ imports: [BillingModule], controllers: [WorkspacesController], providers: [WorkspacesService, CustomersService], exports: [WorkspacesService] })
export class WorkspacesModule {}
