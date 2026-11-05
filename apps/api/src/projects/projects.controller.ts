import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { CreateProjectBody, projectKey, ProjectsService, RolePermissionBody } from './projects.service.js';

@Controller('w/:ws/projects')
@UseGuards(TenantGuard)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.projects.list(auth, tenant);
  }

  @Get('key-available')
  keyAvailable(@Tenant() tenant: TenantInfo, @Query('key') key: string) {
    return this.projects.keyAvailable(tenant, parse(projectKey, key));
  }

  @Post()
  create(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Body() body: unknown) {
    return this.projects.create(auth, tenant, parse(CreateProjectBody, body));
  }

  @Get(':key')
  get(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.projects.get(auth, tenant, key);
  }

  @Get(':key/my-permissions')
  myPermissions(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.projects.myPermissions(auth, tenant, key);
  }

  @Put(':key/role-permissions')
  setRolePermission(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.projects.setRolePermission(auth, tenant, key, parse(RolePermissionBody, body));
  }

  @Post(':key/join-as-admin')
  @HttpCode(200)
  joinAsAdmin(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.projects.joinAsAdmin(auth, tenant, key);
  }
}
