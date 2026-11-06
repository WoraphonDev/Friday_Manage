import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Auth, type AuthInfo, Public, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { AccessRequestsQuery, AccessService, CreateLinkBody, DecideBody } from './access.service.js';
import { MembersService, PatchMemberBody, PatchWorkspaceBody } from './members.service.js';

/** Workspace, สมาชิก, ลิงก์เชิญ และคำขอเข้าร่วม (หน้า H, 7, J4, M1) */
@Controller('w/:ws')
@UseGuards(TenantGuard)
export class WorkspaceAdminController {
  constructor(
    private readonly members: MembersService,
    private readonly access: AccessService,
  ) {}

  @Get()
  get(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.members.get(auth, tenant);
  }

  @Patch()
  patch(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Body() body: unknown) {
    return this.members.patch(auth, tenant, parse(PatchWorkspaceBody, body));
  }

  @Patch('members/:userId')
  patchMember(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('userId') userId: string, @Body() body: unknown) {
    return this.members.patchMember(auth, tenant, userId, parse(PatchMemberBody, body));
  }

  @Get('members/:userId/handover')
  handover(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('userId') userId: string) {
    return this.members.handover(auth, tenant, userId);
  }

  @Post(['members/:userId/deactivate', 'members/:userId\\:deactivate'])
  @HttpCode(200)
  deactivate(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('userId') userId: string) {
    return this.members.deactivate(auth, tenant, userId);
  }

  @Post(['members/:userId/reactivate', 'members/:userId\\:reactivate'])
  @HttpCode(200)
  reactivate(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('userId') userId: string) {
    return this.members.reactivate(auth, tenant, userId);
  }

  @Get('invite-links')
  listLinks(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.access.listLinks(auth, tenant);
  }

  @Post('invite-links')
  createLink(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Body() body: unknown) {
    return this.access.createLink(auth, tenant, parse(CreateLinkBody, body ?? {}));
  }

  @Delete('invite-links/:id')
  revokeLink(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string) {
    return this.access.revokeLink(auth, tenant, id);
  }

  @Get('access-requests')
  listRequests(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Query() query: unknown) {
    return this.access.list(auth, tenant, parse(AccessRequestsQuery, query));
  }

  @Post(['access-requests/:id/approve', 'access-requests/:id\\:approve'])
  @HttpCode(200)
  approve(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.access.decide(auth, tenant, id, 'approve', parse(DecideBody, body ?? {}));
  }

  @Post(['access-requests/:id/reject', 'access-requests/:id\\:reject'])
  @HttpCode(200)
  reject(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string) {
    return this.access.decide(auth, tenant, id, 'reject', {});
  }

  /** M1 · ขอสิทธิ์เข้าโปรเจกต์ (ผู้ขอเป็นสมาชิก Workspace อยู่แล้ว) */
  @Post('projects/:key/access-requests')
  requestProject(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.access.requestProject(auth, tenant, key);
  }
}

/** ขอเข้า Workspace (ผู้ขอยังไม่ได้เป็นสมาชิก จึงไม่ใช้ TenantGuard) */
@Controller('w/:ws/access-requests')
export class WorkspaceJoinRequestController {
  constructor(private readonly access: AccessService) {}

  @Post()
  request(@Auth() auth: AuthInfo, @Param('ws') ws: string) {
    return this.access.requestWorkspace(auth, ws);
  }
}

/** เข้าร่วมด้วยลิงก์เชิญ (J4) */
@Controller('join')
export class JoinController {
  constructor(private readonly access: AccessService) {}

  @Public()
  @Get(':token')
  preview(@Param('token') token: string) {
    return this.access.joinPreview(token);
  }

  @Post(':token')
  @HttpCode(200)
  join(@Auth() auth: AuthInfo, @Param('token') token: string) {
    return this.access.join(auth, token);
  }
}
