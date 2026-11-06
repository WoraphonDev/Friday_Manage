import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { CompleteSprintBody, CreateSprintBody, PatchSprintBody, SprintId } from './sprint-input.js';
import { SprintsService } from './sprints.service.js';

@Controller('w/:ws/projects/:key')
@UseGuards(TenantGuard)
export class SprintsController {
  constructor(private readonly sprints: SprintsService) {}

  @Get('backlog')
  backlog(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.sprints.backlog(auth, tenant, key);
  }

  @Post('sprints')
  create(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.sprints.create(auth, tenant, key, parse(CreateSprintBody, body));
  }

  @Patch('sprints/:id')
  patch(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.sprints.patch(auth, tenant, key, parse(SprintId, id), parse(PatchSprintBody, body));
  }

  @Post(['sprints/:id/start', 'sprints/:id\\:start'])
  @HttpCode(200)
  start(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string) {
    return this.sprints.start(auth, tenant, key, parse(SprintId, id));
  }

  @Post(['sprints/:id/complete', 'sprints/:id\\:complete'])
  @HttpCode(200)
  complete(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.sprints.complete(auth, tenant, key, parse(SprintId, id), parse(CompleteSprintBody, body));
  }
}
