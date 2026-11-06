import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { schema } from '@friday/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantDb, TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { CreateLeaveBody, LeavesQuery, LeavesService } from './leaves.service.js';
import { PatchMeBody, PatchMembershipBody, ProfileService, PutPrefsBody, PutSettingsBody, WorkspaceQuery } from './profile.service.js';

const { users, workspaces, workspaceMembers } = schema;

@Controller('me')
export class MeController {
  constructor(
    private readonly db: TenantDb,
    private readonly profile: ProfileService,
  ) {}

  @Get()
  async me(@Auth() auth: AuthInfo) {
    const [u] = await this.db.run(auth, null, (tx) =>
      tx
        .select({
          id: users.id,
          email: users.email,
          emailVerified: users.emailVerifiedAt,
          displayName: users.displayName,
          firstName: users.firstName,
          lastName: users.lastName,
          phone: users.phone,
          about: users.about,
          avatarUrl: users.avatarUrl,
          locale: users.locale,
          yearFormat: users.yearFormat,
          timezone: users.timezone,
        })
        .from(users)
        .where(eq(users.id, auth.userId)),
    );
    return { ...u, emailVerified: !!u.emailVerified };
  }

  /** I · แก้ข้อมูลส่วนตัว: ชื่อ, ภาษา, ปี พ.ศ. / ค.ศ., timezone */
  @Patch()
  patch(@Auth() auth: AuthInfo, @Body() body: unknown) {
    return this.profile.patchMe(auth, parse(PatchMeBody, body));
  }

  /** ตารางแจ้งเตือน เหตุการณ์ × ช่องทาง (ต่อ Workspace) */
  @Get('notification-prefs')
  prefs(@Auth() auth: AuthInfo, @Query() query: unknown) {
    return this.profile.getPrefs(auth, parse(WorkspaceQuery, query).workspace);
  }

  @Put('notification-prefs')
  putPrefs(@Auth() auth: AuthInfo, @Body() body: unknown) {
    return this.profile.putPrefs(auth, parse(PutPrefsBody, body));
  }

  @Get('notification-settings')
  settings(@Auth() auth: AuthInfo, @Query() query: unknown) {
    return this.profile.getSettings(auth, parse(WorkspaceQuery, query).workspace);
  }

  @Put('notification-settings')
  putSettings(@Auth() auth: AuthInfo, @Body() body: unknown) {
    return this.profile.putSettings(auth, parse(PutSettingsBody, body));
  }

  /** Q1 · เมนูสลับ Workspace */
  @Get('workspaces')
  async workspaces(@Auth() auth: AuthInfo) {
    const items = await this.db.run(auth, null, (tx) =>
      tx
        .select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name, logoUrl: workspaces.logoUrl, status: workspaces.status, role: workspaceMembers.role })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .where(and(eq(workspaceMembers.userId, auth.userId), eq(workspaceMembers.status, 'active'), isNull(workspaces.deletedAt)))
        .orderBy(asc(workspaces.name)),
    );
    return { items };
  }
}

/** ตำแหน่ง / Capacity / เวลาทำงานของฉันใน Workspace นี้ */
@Controller('w/:ws')
@UseGuards(TenantGuard)
export class MyMembershipController {
  constructor(
    private readonly profile: ProfileService,
    private readonly leaves: LeavesService,
  ) {}

  @Get('me/membership')
  membership(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.profile.getMembership(auth, tenant);
  }

  @Patch('me/membership')
  patchMembership(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Body() body: unknown) {
    return this.profile.patchMembership(auth, tenant, parse(PatchMembershipBody, body));
  }

  @Get('leaves')
  listLeaves(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Query() query: unknown) {
    return this.leaves.list(auth, tenant, parse(LeavesQuery, query));
  }

  @Post('leaves')
  createLeave(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Body() body: unknown) {
    return this.leaves.create(auth, tenant, parse(CreateLeaveBody, body));
  }

  @Post(['leaves/:id/approve', 'leaves/:id\\:approve'])
  @HttpCode(200)
  approveLeave(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string) {
    return this.leaves.approve(auth, tenant, id);
  }

  @Delete('leaves/:id')
  deleteLeave(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string) {
    return this.leaves.remove(auth, tenant, id);
  }
}
