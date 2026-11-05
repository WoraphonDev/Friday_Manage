import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { OverviewQuery, OverviewService, ProjectWorkloadQuery, WorkspaceWorkloadQuery } from './overview.service.js';

/** หน้า 1 · Overview, หน้า 7 · Workload และ N1 · Workload รวมทุกโปรเจกต์ */
@Controller('w/:ws')
@UseGuards(TenantGuard)
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get('projects/:key/overview')
  project(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Query() query: unknown) {
    return this.overview.overview(auth, tenant, key, parse(OverviewQuery, query));
  }

  @Get('projects/:key/workload')
  projectWorkload(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Query() query: unknown) {
    return this.overview.projectWorkload(auth, tenant, key, parse(ProjectWorkloadQuery, query));
  }

  @Get('workload')
  workspaceWorkload(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Query() query: unknown) {
    return this.overview.workspaceWorkload(auth, tenant, parse(WorkspaceWorkloadQuery, query));
  }
}
