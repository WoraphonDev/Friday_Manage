import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { CreateIssueBody, IssuesService, ListQuery, PatchIssueBody } from './issues.service.js';

@Controller('w/:ws')
@UseGuards(TenantGuard)
export class IssuesController {
  constructor(private readonly issues: IssuesService) {}

  @Get('projects/:key/issues')
  list(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Query() query: unknown) {
    return this.issues.list(auth, tenant, key, parse(ListQuery, query));
  }

  @Post('projects/:key/issues')
  create(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.issues.create(auth, tenant, key, parse(CreateIssueBody, body));
  }

  @Get('issues/:issueKey')
  async get(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') issueKey: string, @Res({ passthrough: true }) res: Response) {
    const issue = await this.issues.get(auth, tenant, issueKey);
    res.setHeader('ETag', `"${issue.version}"`);
    return issue;
  }

  @Patch('issues/:issueKey')
  async patch(
    @Auth() auth: AuthInfo,
    @Tenant() tenant: TenantInfo,
    @Param('issueKey') issueKey: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const issue = await this.issues.patch(auth, tenant, issueKey, ifMatch, parse(PatchIssueBody, body));
    res.setHeader('ETag', `"${issue.version}"`);
    return issue;
  }
}
