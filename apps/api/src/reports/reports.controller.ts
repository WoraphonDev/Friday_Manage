import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { DueQuery } from './due-report.js';
import { InsightsService } from './insights.service.js';
import { ForecastQuery, ReportsService, TraceQuery, WeeklyQuery } from './reports.service.js';

/** O1 · Lead Dashboard และ O2 · Reports · Guest → 403 */
@Controller('w/:ws/projects/:key')
@UseGuards(TenantGuard)
export class ReportsController {
  constructor(
    private readonly insights: InsightsService,
    private readonly reports: ReportsService,
  ) {}

  @Get('insights/risks')
  risks(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.insights.risks(auth, tenant, key);
  }

  @Get('insights/modules')
  modules(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.insights.modules(auth, tenant, key);
  }

  @Get('reports/weekly')
  weekly(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Query() query: unknown) {
    return this.reports.weekly(auth, tenant, key, parse(WeeklyQuery, query));
  }

  @Get('reports/module-forecast')
  moduleForecast(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Query() query: unknown) {
    return this.reports.moduleForecast(auth, tenant, key, parse(ForecastQuery, query));
  }

  /** งานที่จะเสร็จ: งานและแผน Module › Phase ที่ Plan End อยู่ในช่วง กรองตาม Module / BA / SA / DEV */
  @Get('reports/due')
  due(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Query() query: unknown) {
    return this.reports.due(auth, tenant, key, parse(DueQuery, query));
  }

  @Get('reports/traceability')
  traceability(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Query() query: unknown) {
    return this.reports.traceability(auth, tenant, key, parse(TraceQuery, query));
  }
}
