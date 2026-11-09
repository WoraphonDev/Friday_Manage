import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { type Db, schema } from '@friday/db';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { SYSTEM_DB } from '../db/db.module.js';
import { AppError } from '../common/errors.js';
import { Auth, type AuthInfo } from '../common/request.js';
import { parse } from '../common/validate.js';

const { workspaces, workspaceSettings, securityPolicies, workspaceMembers, auditLogs } = schema;

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'ใช้ a–z, 0–9 และ - ความยาว 2–63 ตัว');
const CreateBody = z.object({ name: z.string().trim().min(1).max(80), slug });

// ชื่อที่สงวนไว้เพราะชนกับ path ของระบบ
const RESERVED = new Set(['api', 'app', 'admin', 'ops', 'join', 'login', 'signup', 'w', 'www', 'help', 'status']);

@Controller('workspaces')
export class WorkspacesController {
  constructor(
    @Inject(SYSTEM_DB) private readonly db: Db,
    private readonly analytics: AnalyticsService,
  ) {}

  @Get('slug-available')
  async slugAvailable(@Query('slug') value: string) {
    const s = parse(slug, value);
    return { slug: s, available: await this.isFree(this.db, s) };
  }

  /**
   * J5 / Q1 · สร้าง Workspace แล้วผู้สร้างเป็น Owner · ทดลอง Team 14 วัน (สถานะ trial)
   * ใช้ friday_system เพราะยังไม่มี Workspace ให้ RLS อ้างถึง
   */
  @Post()
  async create(@Auth() auth: AuthInfo, @Body() body: unknown) {
    const input = parse(CreateBody, body);
    return this.db.transaction(async (tx) => {
      if (!(await this.isFree(tx, input.slug))) throw new AppError(409, 'slug_taken', 'URL นี้มีคนใช้แล้ว', { slug: input.slug });
      const [ws] = await tx.insert(workspaces).values({ name: input.name, slug: input.slug }).returning();
      await tx.insert(workspaceSettings).values({ workspaceId: ws.id });
      await tx.insert(securityPolicies).values({ workspaceId: ws.id });
      await tx.insert(workspaceMembers).values({ workspaceId: ws.id, userId: auth.userId, role: 'owner' });
      await tx.insert(auditLogs).values({ workspaceId: ws.id, actorId: auth.userId, actorKind: 'user', category: 'data', action: 'workspace.created', targetType: 'workspace', targetId: ws.id, summary: ws.name });
      await this.analytics.copyAcquisition(tx, ws.id, auth.userId);
      return { id: ws.id, slug: ws.slug, name: ws.name, status: ws.status, role: 'owner' };
    });
  }

  private async isFree(db: Pick<Db, 'select'>, s: string) {
    if (RESERVED.has(s)) return false;
    const [row] = await db.select({ id: workspaces.id }).from(workspaces).where(sql`lower(${workspaces.slug}) = ${s}`);
    return !row;
  }
}
