import { Injectable } from '@nestjs/common';
import { schema } from '@friday/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, forbidden, notFound } from '../common/errors.js';
import { loadPeople } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { hashApiToken, newApiToken, TOKEN_SCOPES } from './api-tokens.js';

const s = schema;
const MAX_ACTIVE = 20;
const Scopes = z.array(z.enum(TOKEN_SCOPES)).min(1).max(10).transform((v) => [...new Set(v)]);

export const CreateTokenBody = z.object({ name: z.string().trim().min(1).max(80), scopes: Scopes.default(['read']) });
export const PatchTokenBody = z.object({ name: z.string().trim().min(1).max(80), scopes: Scopes }).partial().refine((v) => Object.keys(v).length > 0, 'ต้องระบุค่าที่จะแก้');

/** N1 › API tokens · จัดการโดย Owner / Admin (`ws.settings`) · เรียกด้วย API token เองไม่ได้ */
@Injectable()
export class ApiTokensService {
  constructor(private readonly db: TenantDb) {}

  private admin(tenant: TenantInfo) {
    if (tenant.role !== 'owner' && tenant.role !== 'admin') throw forbidden('ws.settings');
  }

  private dto(t: typeof s.apiTokens.$inferSelect, people: Map<string, unknown>) {
    return { id: t.id, name: t.name, scopes: t.scopes, createdBy: people.get(t.createdBy) ?? null, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, revoked: !!t.revokedAt, revokedAt: t.revokedAt };
  }

  async list(auth: AuthInfo, tenant: TenantInfo) {
    this.admin(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const rows = await tx.select().from(s.apiTokens).where(and(eq(s.apiTokens.workspaceId, tenant.workspaceId), isNull(s.apiTokens.revokedAt))).orderBy(desc(s.apiTokens.createdAt));
      const people = await loadPeople(tx, rows.map((r) => r.createdBy));
      return { items: rows.map((r) => this.dto(r, people)) };
    });
  }

  /** token เต็มแสดงครั้งเดียวตอนสร้าง · ในฐานข้อมูลเก็บเฉพาะ SHA-256 */
  async create(auth: AuthInfo, tenant: TenantInfo, body: z.infer<typeof CreateTokenBody>) {
    this.admin(tenant);
    const token = newApiToken();
    return this.db.run(auth, tenant, async (tx) => {
      const active = await tx.select({ id: s.apiTokens.id }).from(s.apiTokens).where(and(eq(s.apiTokens.workspaceId, tenant.workspaceId), isNull(s.apiTokens.revokedAt)));
      if (active.length >= MAX_ACTIVE) throw new AppError(422, 'api_token_limit', `สร้าง API token ที่ใช้งานอยู่ได้ไม่เกิน ${MAX_ACTIVE} ตัว · ยกเลิกตัวที่ไม่ใช้ก่อน`);
      const [row] = await tx.insert(s.apiTokens).values({ workspaceId: tenant.workspaceId, name: body.name, tokenHash: hashApiToken(token), scopes: body.scopes, createdBy: auth.userId }).returning();
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'secu', action: 'api_token.created', targetType: 'api_token', targetId: row.id, summary: `${body.name} · ${body.scopes.join(',')}` });
      const people = await loadPeople(tx, [auth.userId]);
      return { ...this.dto(row, people), token };
    });
  }

  async patch(auth: AuthInfo, tenant: TenantInfo, id: string, body: z.infer<typeof PatchTokenBody>) {
    this.admin(tenant);
    if (!z.uuid().safeParse(id).success) throw notFound('API token');
    return this.db.run(auth, tenant, async (tx) => {
      const [row] = await tx.update(s.apiTokens).set(body).where(and(eq(s.apiTokens.id, id), eq(s.apiTokens.workspaceId, tenant.workspaceId), isNull(s.apiTokens.revokedAt))).returning();
      if (!row) throw notFound('API token');
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'secu', action: 'api_token.updated', targetType: 'api_token', targetId: id, summary: `${row.name} · ${row.scopes.join(',')}` });
      return this.dto(row, await loadPeople(tx, [row.createdBy]));
    });
  }

  /** ยกเลิก = ใช้ไม่ได้ทันที (ตรวจทุกคำขอ) */
  async revoke(auth: AuthInfo, tenant: TenantInfo, id: string) {
    this.admin(tenant);
    if (!z.uuid().safeParse(id).success) throw notFound('API token');
    return this.db.run(auth, tenant, async (tx) => {
      const [row] = await tx.update(s.apiTokens).set({ revokedAt: new Date() }).where(and(eq(s.apiTokens.id, id), eq(s.apiTokens.workspaceId, tenant.workspaceId), isNull(s.apiTokens.revokedAt))).returning();
      if (!row) throw notFound('API token');
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'secu', action: 'api_token.revoked', targetType: 'api_token', targetId: id, summary: row.name });
      return { revoked: true };
    });
  }
}
