import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { CreateBaselineBody, GanttQuery, GanttService, PlanChangesQuery, XlsxQuery } from './gantt.service.js';

@Controller('w/:ws/projects/:key')
@UseGuards(TenantGuard)
export class GanttController {
  constructor(private readonly gantt: GanttService) {}

  @Get('gantt')
  view(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Query() query: unknown) {
    return this.gantt.gantt(auth, tenant, key, parse(GanttQuery, query));
  }

  @Get('baselines')
  baselines(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.gantt.listBaselines(auth, tenant, key);
  }

  @Post('baselines')
  createBaseline(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.gantt.createBaseline(auth, tenant, key, parse(CreateBaselineBody, body ?? {}));
  }

  @Get('plan-changes')
  planChanges(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Query() query: unknown) {
    return this.gantt.planChanges(auth, tenant, key, parse(PlanChangesQuery, query));
  }

  @Get('plan-changes.xlsx')
  async planChangesXlsx(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Query() query: unknown, @Res({ passthrough: true }) res: Response) {
    const file = await this.gantt.planChangesXlsx(auth, tenant, key, parse(XlsxQuery, query));
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${file.filename}"`,
    });
    return new StreamableFile(file.buffer);
  }

  @Post(['schedule/preview', 'schedule\\:preview'])
  @HttpCode(200)
  schedulePreview(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.gantt.schedulePreview(auth, tenant, key);
  }
}
