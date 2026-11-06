import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { AutomationService } from './automation.service.js';
import { DryRunBody, PatchRuleBody, RuleBody, RunsQuery } from './rules.js';

/** Automation (หน้า P2) · 03-api › 3.9 */
@Controller('w/:ws')
@UseGuards(TenantGuard)
export class AutomationController {
  constructor(private readonly automation: AutomationService) {}

  @Get('automation-templates')
  templates(@Tenant() t: TenantInfo) {
    return this.automation.templates(t);
  }

  @Get('projects/:key/automations')
  list(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('key') key: string) {
    return this.automation.list(a, t, key);
  }

  // ต้องอยู่ก่อน automations/:id
  @Get('projects/:key/automations/runs')
  runs(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('key') key: string, @Query() q: unknown) {
    return this.automation.runs(a, t, key, parse(RunsQuery, q));
  }

  @Post('projects/:key/automations')
  create(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.automation.create(a, t, key, parse(RuleBody, body));
  }

  @Get('projects/:key/automations/:id')
  get(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('key') key: string, @Param('id') id: string) {
    return this.automation.get(a, t, key, id);
  }

  @Patch('projects/:key/automations/:id')
  patch(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.automation.patch(a, t, key, id, parse(PatchRuleBody, body));
  }

  @Delete('projects/:key/automations/:id')
  remove(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('key') key: string, @Param('id') id: string) {
    return this.automation.remove(a, t, key, id);
  }

  @Post(['projects/:key/automations/:id/dry-run', 'projects/:key/automations/:id\\:dry-run'])
  @HttpCode(200)
  dryRun(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.automation.dryRun(a, t, key, id, parse(DryRunBody, body ?? {}));
  }
}
