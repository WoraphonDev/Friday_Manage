import { Body, Controller, Get, HttpCode, Module, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { type OpsRequest, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { ChangePlanBody, DiscountBody, ExtendTrialBody, type Gated, ListQuery, ResumeBody, SuspendBody, WorkspacesService } from './workspaces.service.js';

/** เกินวงเงิน → 202 พร้อมคำขออนุมัติ · ไม่เกิน → 200 พร้อมผล */
async function respond<T extends object>(res: Response, p: Promise<Gated<T>>) {
  const r = await p;
  if ('pendingApproval' in r) res.status(202);
  return r;
}

/** Workspace ของลูกค้า (O02 ขยายรายละเอียด 9 แท็บ) */
@Controller('ops')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get('workspaces')
  list(@Query() q: unknown) {
    return this.workspaces.list(parse(ListQuery, q));
  }
  @Get('workspaces/:id')
  get(@Param('id') id: string) {
    return this.workspaces.get(id);
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
}

@Module({ controllers: [WorkspacesController], providers: [WorkspacesService], exports: [WorkspacesService] })
export class WorkspacesModule {}
