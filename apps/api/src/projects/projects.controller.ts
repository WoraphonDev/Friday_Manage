import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { AddMemberBody, ProjectMembersService, RemoveMemberBody, UpdateMemberBody } from './project-members.service.js';
import {
  CreateProjectBody,
  DeleteProjectBody,
  ListProjectsQuery,
  PatchProjectBody,
  projectKey,
  ProjectsService,
  RolePermissionBody,
  SampleProjectBody,
  TransferBody,
} from './projects.service.js';
import { SampleProjectService } from './sample-project.service.js';

@Controller('w/:ws/projects')
@UseGuards(TenantGuard)
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly members: ProjectMembersService,
    private readonly sample: SampleProjectService,
  ) {}

  @Get()
  list(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Query() query: unknown) {
    return this.projects.list(auth, tenant, parse(ListProjectsQuery, query));
  }

  @Get('key-available')
  keyAvailable(@Tenant() tenant: TenantInfo, @Query('key') key: string) {
    return this.projects.keyAvailable(tenant, parse(projectKey, key));
  }

  @Post()
  create(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Body() body: unknown) {
    return this.projects.create(auth, tenant, parse(CreateProjectBody, body));
  }

  /** โปรเจกต์ตัวอย่างที่ใช้ข้อมูลสมมติ (03-api › `w/projects:sample`) */
  @Post('sample')
  createSample(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Body() body: unknown) {
    return this.sample.create(auth, tenant, parse(SampleProjectBody, body ?? {}));
  }

  @Get(':key')
  async get(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Res({ passthrough: true }) res: Response) {
    const project = await this.projects.get(auth, tenant, key);
    res.setHeader('ETag', `"${project.version}"`);
    return project;
  }

  @Patch(':key')
  async patch(
    @Auth() auth: AuthInfo,
    @Tenant() tenant: TenantInfo,
    @Param('key') key: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const project = await this.projects.patch(auth, tenant, key, ifMatch, parse(PatchProjectBody, body));
    res.setHeader('ETag', `"${project.version}"`);
    return project;
  }

  @Delete(':key')
  remove(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.projects.remove(auth, tenant, key, parse(DeleteProjectBody, body ?? {}));
  }

  @Get(':key/delete-impact')
  deleteImpact(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.projects.deleteImpact(auth, tenant, key);
  }

  @Post(':key/archive')
  @HttpCode(200)
  archive(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.projects.archive(auth, tenant, key);
  }

  @Post(':key/restore')
  @HttpCode(200)
  restore(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.projects.restore(auth, tenant, key);
  }

  @Post(':key/transfer')
  @HttpCode(200)
  transfer(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.projects.transfer(auth, tenant, key, parse(TransferBody, body));
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

  // ---------------------------------------------------------------------------
  // สมาชิกโปรเจกต์ (หน้า 7, L2)
  // ---------------------------------------------------------------------------
  @Get(':key/members')
  listMembers(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.members.list(auth, tenant, key);
  }

  @Post(':key/members')
  addMember(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.members.add(auth, tenant, key, parse(AddMemberBody, body));
  }

  @Patch(':key/members/:userId')
  updateMember(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('userId') userId: string, @Body() body: unknown) {
    return this.members.update(auth, tenant, key, parseUserId(userId), parse(UpdateMemberBody, body));
  }

  @Delete(':key/members/:userId')
  removeMember(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('userId') userId: string, @Body() body: unknown) {
    return this.members.remove(auth, tenant, key, parseUserId(userId), parse(RemoveMemberBody, body ?? {}));
  }
}

function parseUserId(v: string) {
  return parse(AddMemberBody.shape.userId, v);
}
