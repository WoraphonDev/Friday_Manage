import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { AssigneesBody, BulkIssueBody, CreateIssueBody, IssuesService, ListQuery, MoveIssueBody, PatchIssueBody } from './issues.service.js';

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

  @Get('projects/:key/form-options')
  formOptions(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.issues.formOptions(auth, tenant, key);
  }

  @Post('projects/:key/issues/bulk')
  @HttpCode(200)
  bulk(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.issues.bulk(auth, tenant, key, parse(BulkIssueBody, body));
  }

  @Get('issues/:issueKey/delete-impact')
  deleteImpact(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string) {
    return this.issues.deleteImpact(auth, tenant, key);
  }

  @Delete('issues/:issueKey')
  remove(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string) {
    return this.issues.remove(auth, tenant, key);
  }

  @Post('issues/:issueKey/restore')
  @HttpCode(200)
  async restore(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string, @Res({ passthrough: true }) res: Response) {
    const issue = await this.issues.restore(auth, tenant, key);
    res.setHeader('ETag', `"${issue.version}"`);
    return issue;
  }

  @Post('issues/:issueKey/reopen')
  @HttpCode(200)
  async reopen(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string, @Res({ passthrough: true }) res: Response) {
    const issue = await this.issues.reopen(auth, tenant, key);
    res.setHeader('ETag', `"${issue.version}"`);
    return issue;
  }

  @Put('issues/:issueKey/assignees')
  async assignees(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const issue = await this.issues.setAssignees(auth, tenant, key, ifMatch, parse(AssigneesBody, body));
    res.setHeader('ETag', `"${issue.version}"`);
    return issue;
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

  /** Kanban / Backlog / Mobile: เปลี่ยนสถานะ, Sprint และลำดับ · ส่ง If-Match ได้ถ้าต้องการกันชน */
  @Post('issues/:issueKey/move')
  @HttpCode(200)
  async move(
    @Auth() auth: AuthInfo,
    @Tenant() tenant: TenantInfo,
    @Param('issueKey') issueKey: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const issue = await this.issues.move(auth, tenant, issueKey, ifMatch, parse(MoveIssueBody, body));
    res.setHeader('ETag', `"${issue.version}"`);
    return issue;
  }
}
