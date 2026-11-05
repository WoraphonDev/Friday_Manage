import { Controller, Get, UseGuards } from '@nestjs/common';
import { schema } from '@friday/db';
import { asc, eq } from 'drizzle-orm';
import { forbidden } from '../common/errors.js';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantDb, TenantGuard } from '../common/tenant.js';

const s = schema;

/** H · รายชื่อสมาชิก Workspace · Guest ไม่เห็นรายชื่อคนในองค์กร */
@Controller('w/:ws/members')
@UseGuards(TenantGuard)
export class MembersController {
  constructor(private readonly db: TenantDb) {}

  @Get()
  async list(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    if (tenant.role === 'guest') throw forbidden('ws.directory.view');
    const items = await this.db.run(auth, tenant, (tx) =>
      tx
        .select({
          userId: s.workspaceMembers.userId,
          displayName: s.users.displayName,
          email: s.users.email,
          role: s.workspaceMembers.role,
          status: s.workspaceMembers.status,
          jobTitle: s.workspaceMembers.jobTitle,
          capacityHoursWeek: s.workspaceMembers.capacityHoursWeek,
          lastActiveAt: s.workspaceMembers.lastActiveAt,
        })
        .from(s.workspaceMembers)
        .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
        .orderBy(asc(s.users.displayName)),
    );
    return { items };
  }
}
