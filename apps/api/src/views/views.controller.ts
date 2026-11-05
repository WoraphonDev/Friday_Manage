import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { BoardQuery, TimelineQuery, ViewsService } from './views.service.js';

/** ข้อมูลของหน้า 3 · Kanban และ 4 · Timeline */
@Controller('w/:ws/projects/:key')
@UseGuards(TenantGuard)
export class ViewsController {
  constructor(private readonly views: ViewsService) {}

  @Get('board')
  board(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Query() query: unknown) {
    return this.views.board(auth, tenant, key, parse(BoardQuery, query));
  }

  @Get('timeline')
  timeline(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Query() query: unknown) {
    return this.views.timeline(auth, tenant, key, parse(TimelineQuery, query));
  }
}
