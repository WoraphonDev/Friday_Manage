import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { CreateBugBody, CreateTestRunBody, CreateTimeLogBody, QaService } from './qa.service.js';

/** ผลทดสอบและบันทึกเวลาของงาน (หน้า C, D, K2, M4) */
@Controller('w/:ws/issues/:issueKey')
@UseGuards(TenantGuard)
export class QaController {
  constructor(private readonly qa: QaService) {}

  @Get('test-runs')
  runs(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string) {
    return this.qa.listRuns(auth, tenant, key);
  }

  @Post('test-runs')
  createRun(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string, @Body() body: unknown) {
    return this.qa.createRun(auth, tenant, key, parse(CreateTestRunBody, body));
  }

  @Post(['test-runs/:id/create-bug', 'test-runs/:id\\:create-bug'])
  createBug(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.qa.createBug(auth, tenant, key, id, parse(CreateBugBody, body ?? {}));
  }

  @Get('time-logs')
  logs(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string) {
    return this.qa.listLogs(auth, tenant, key);
  }

  @Post('time-logs')
  createLog(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string, @Body() body: unknown) {
    return this.qa.createLog(auth, tenant, key, parse(CreateTimeLogBody, body));
  }

  @Delete('time-logs/:id')
  @HttpCode(200)
  deleteLog(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string, @Param('id') id: string) {
    return this.qa.deleteLog(auth, tenant, key, id);
  }
}
