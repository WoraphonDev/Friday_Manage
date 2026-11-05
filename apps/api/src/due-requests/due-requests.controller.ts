import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { CreateDueRequestBody, DecideBody, DueRequestsService, ListDueRequestsQuery, PreviewQuery } from './due-requests.service.js';

/** คำขอเลื่อน Due (K3) และการอนุมัติจาก Inbox (G) / Home (E) */
@Controller('w/:ws')
@UseGuards(TenantGuard)
export class DueRequestsController {
  constructor(private readonly requests: DueRequestsService) {}

  @Get('issues/:issueKey/due-requests/preview')
  preview(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') issueKey: string, @Query() query: unknown) {
    return this.requests.preview(auth, tenant, issueKey, parse(PreviewQuery, query).due);
  }

  @Get('issues/:issueKey/due-requests')
  listForIssue(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') issueKey: string) {
    return this.requests.listForIssue(auth, tenant, issueKey);
  }

  @Post('issues/:issueKey/due-requests')
  create(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') issueKey: string, @Body() body: unknown) {
    return this.requests.create(auth, tenant, issueKey, parse(CreateDueRequestBody, body));
  }

  @Get('due-requests')
  list(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Query() query: unknown) {
    return this.requests.list(auth, tenant, parse(ListDueRequestsQuery, query));
  }

  @Post('due-requests/:id/approve')
  @HttpCode(200)
  approve(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.requests.decide(auth, tenant, id, 'approve', parse(DecideBody, body ?? {}).note);
  }

  @Post('due-requests/:id/reject')
  @HttpCode(200)
  reject(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.requests.decide(auth, tenant, id, 'reject', parse(DecideBody, body ?? {}).note);
  }

  @Post('due-requests/:id/cancel')
  @HttpCode(200)
  cancel(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string) {
    return this.requests.decide(auth, tenant, id, 'cancel');
  }
}
