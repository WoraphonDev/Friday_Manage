import { Controller, Get } from '@nestjs/common';
import { schema } from '@friday/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { Auth, type AuthInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';

const { users, workspaces, workspaceMembers } = schema;

@Controller('me')
export class MeController {
  constructor(private readonly db: TenantDb) {}

  @Get()
  async me(@Auth() auth: AuthInfo) {
    const [u] = await this.db.run(auth, null, (tx) =>
      tx
        .select({
          id: users.id,
          email: users.email,
          emailVerified: users.emailVerifiedAt,
          displayName: users.displayName,
          locale: users.locale,
          yearFormat: users.yearFormat,
          timezone: users.timezone,
        })
        .from(users)
        .where(eq(users.id, auth.userId)),
    );
    return { ...u, emailVerified: !!u.emailVerified };
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
