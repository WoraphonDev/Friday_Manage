import { Body, Controller, Get, Global, HttpCode, Module, Param, Post, Query, Req } from '@nestjs/common';
import { type OpsRequest, Reauth, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { ApprovalsQuery, ApprovalsService, DecisionBody } from './approvals.service.js';

/** คำขออนุมัติ (G7, G8, G12) · อนุมัติ / ไม่อนุมัติได้เฉพาะ Owner และต้องแตะกุญแจซ้ำเมื่ออนุมัติ */
@Controller('ops/approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  list(@Req() req: OpsRequest, @Query() q: unknown) {
    return this.approvals.list(req.staff!, parse(ApprovalsQuery, q));
  }

  @Roles('owner')
  @Reauth()
  @Post([':id/approve', ':id\\:approve'])
  @HttpCode(200)
  approve(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.approvals.approve(req.staff!, id, parse(DecisionBody, body ?? {}).note);
  }

  @Roles('owner')
  @Post([':id/reject', ':id\\:reject'])
  @HttpCode(200)
  reject(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.approvals.reject(req.staff!, id, parse(DecisionBody, body ?? {}).note);
  }

  @Post([':id/cancel', ':id\\:cancel'])
  @HttpCode(200)
  cancel(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.approvals.cancel(req.staff!, id);
  }
}

/** Global: ทุก module เรียก `gate()` / `register()` ได้โดยไม่ต้อง import */
@Global()
@Module({ controllers: [ApprovalsController], providers: [ApprovalsService], exports: [ApprovalsService] })
export class ApprovalsModule {}
