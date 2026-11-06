import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Staff } from '../auth/auth.guard.js';
import { audit } from '../audit.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';

const s = schema;
export const FlagBody = z.object({ key: z.string().trim().regex(/^[a-z][a-z0-9_.-]{1,62}$/, 'key ใช้ตัวพิมพ์เล็ก ตัวเลข _ . -'), description: z.string().trim().max(300).nullish(), defaultOn: z.boolean().default(false) }).strict();
export const PatchFlagBody = FlagBody.partial().strict();
export const OverrideBody = z.object({ enabled: z.boolean() }).strict();
export const AnnouncementBody = z
  .object({
    message: z.string().trim().min(1).max(1000),
    audience: z.enum(['all', 'owners_admins']).default('all'),
    channels: z.array(z.enum(['banner', 'email'])).min(1).default(['banner']),
    scheduledAt: z.iso.datetime({ offset: true }).nullish(),
  })
  .strict();
export const PatchAnnouncementBody = AnnouncementBody.partial().strict();

const uuid = (id: string, what: string) => {
  if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', `ไม่พบ${what}`);
  return id;
};

/** Feature flag (เปิดให้บางลูกค้า) และประกาศถึงลูกค้า · ไม่ผูก Workspace จึงไม่มี audit_logs ของลูกค้า (เฉพาะ override ต่อ Workspace) */
@Injectable()
export class FlagsService {
  constructor(@Inject(OPS_DB) private readonly db: Db) {}

  async listFlags() {
    const flags = await this.db.select().from(s.featureFlags).orderBy(asc(s.featureFlags.key));
    const overrides = await this.db.select({ o: s.featureFlagOverrides, slug: s.workspaces.slug, name: s.workspaces.name }).from(s.featureFlagOverrides).innerJoin(s.workspaces, eq(s.workspaces.id, s.featureFlagOverrides.workspaceId));
    return { items: flags.map((f) => ({ ...this.flag(f), overrides: overrides.filter((x) => x.o.flagId === f.id).map((x) => ({ workspaceId: x.o.workspaceId, slug: x.slug, name: x.name, enabled: x.o.enabled })) })) };
  }
  async createFlag(input: z.infer<typeof FlagBody>) {
    const [row] = await this.db.insert(s.featureFlags).values({ key: input.key, description: input.description ?? null, defaultOn: input.defaultOn }).returning();
    return this.flag(row);
  }
  async patchFlag(id: string, input: z.infer<typeof PatchFlagBody>) {
    const [row] = await this.db.update(s.featureFlags).set({ ...input, updatedAt: new Date() }).where(eq(s.featureFlags.id, uuid(id, ' flag'))).returning();
    if (!row) throw new AppError(404, 'not_found', 'ไม่พบ flag');
    return this.flag(row);
  }
  async deleteFlag(id: string) {
    const gone = await this.db.delete(s.featureFlags).where(eq(s.featureFlags.id, uuid(id, ' flag'))).returning({ id: s.featureFlags.id });
    if (!gone.length) throw new AppError(404, 'not_found', 'ไม่พบ flag');
    return { id, deleted: true };
  }

  /** เปิด / ปิด flag ให้ Workspace เดียว · เขียน audit_logs ของ Workspace นั้น */
  async setOverride(staff: Staff, flagId: string, workspaceId: string, input: z.infer<typeof OverrideBody>) {
    const [flag] = await this.db.select().from(s.featureFlags).where(eq(s.featureFlags.id, uuid(flagId, ' flag')));
    const [ws] = await this.db.select({ id: s.workspaces.id }).from(s.workspaces).where(eq(s.workspaces.id, uuid(workspaceId, ' Workspace')));
    if (!flag || !ws) throw new AppError(404, 'not_found', 'ไม่พบ flag หรือ Workspace');
    await this.db.transaction(async (tx) => {
      await tx.insert(s.featureFlagOverrides).values({ flagId, workspaceId, enabled: input.enabled }).onConflictDoUpdate({ target: [s.featureFlagOverrides.flagId, s.featureFlagOverrides.workspaceId], set: { enabled: input.enabled, updatedAt: new Date() } });
      await audit(tx, staff, workspaceId, 'plan', 'ops.feature_override', `${input.enabled ? 'เปิด' : 'ปิด'}ฟีเจอร์ ${flag.key} ให้ Workspace นี้`, { type: 'feature_flag', id: flagId });
    });
    return { flagId, workspaceId, enabled: input.enabled };
  }
  async removeOverride(staff: Staff, flagId: string, workspaceId: string) {
    uuid(flagId, ' flag');
    uuid(workspaceId, ' Workspace');
    const [flag] = await this.db.select().from(s.featureFlags).where(eq(s.featureFlags.id, flagId));
    const gone = await this.db.transaction(async (tx) => {
      const r = await tx.delete(s.featureFlagOverrides).where(eq(s.featureFlagOverrides.flagId, flagId)).returning({ ws: s.featureFlagOverrides.workspaceId });
      const mine = r.filter((x) => x.ws === workspaceId);
      if (mine.length) await audit(tx, staff, workspaceId, 'plan', 'ops.feature_override_removed', `ลบการกำหนดฟีเจอร์ ${flag?.key} ของ Workspace นี้`, { type: 'feature_flag', id: flagId });
      return mine.length;
    });
    if (!gone) throw new AppError(404, 'not_found', 'ไม่พบการกำหนดนี้');
    return { flagId, workspaceId, removed: true };
  }

  private flag(f: typeof s.featureFlags.$inferSelect) {
    return { id: f.id, key: f.key, description: f.description, defaultOn: f.defaultOn, createdAt: f.createdAt, updatedAt: f.updatedAt };
  }

  // ---------------------------------------------------------------------------

  async listAnnouncements() {
    return { items: (await this.db.select().from(s.announcements).orderBy(asc(s.announcements.createdAt))).map((a) => this.ann(a)) };
  }
  async createAnnouncement(input: z.infer<typeof AnnouncementBody>) {
    const [row] = await this.db.insert(s.announcements).values({ message: input.message, audience: input.audience, channels: input.channels, scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null }).returning();
    return this.ann(row);
  }
  async patchAnnouncement(id: string, input: z.infer<typeof PatchAnnouncementBody>) {
    const [cur] = await this.db.select().from(s.announcements).where(eq(s.announcements.id, uuid(id, 'ประกาศ')));
    if (!cur) throw new AppError(404, 'not_found', 'ไม่พบประกาศ');
    if (cur.sentAt) throw new AppError(409, 'announcement_sent', 'ประกาศนี้ส่งไปแล้ว แก้ไม่ได้');
    const [row] = await this.db.update(s.announcements).set({ ...(input.message !== undefined ? { message: input.message } : {}), ...(input.audience ? { audience: input.audience } : {}), ...(input.channels ? { channels: input.channels } : {}), ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null } : {}), updatedAt: new Date() }).where(eq(s.announcements.id, id)).returning();
    return this.ann(row);
  }
  async deleteAnnouncement(id: string) {
    const gone = await this.db.delete(s.announcements).where(eq(s.announcements.id, uuid(id, 'ประกาศ'))).returning({ id: s.announcements.id });
    if (!gone.length) throw new AppError(404, 'not_found', 'ไม่พบประกาศ');
    return { id, deleted: true };
  }
  /** ปล่อยประกาศทันที (banner ให้ API ลูกค้าอ่านจาก announcements ที่ sent_at ไม่ว่าง) */
  async publishAnnouncement(id: string) {
    const [cur] = await this.db.select().from(s.announcements).where(eq(s.announcements.id, uuid(id, 'ประกาศ')));
    if (!cur) throw new AppError(404, 'not_found', 'ไม่พบประกาศ');
    if (cur.sentAt) throw new AppError(409, 'announcement_sent', 'ประกาศนี้ส่งไปแล้ว');
    const [row] = await this.db.update(s.announcements).set({ sentAt: new Date(), updatedAt: new Date() }).where(eq(s.announcements.id, id)).returning();
    return this.ann(row);
  }
  private ann(a: typeof s.announcements.$inferSelect) {
    return { id: a.id, message: a.message, audience: a.audience, channels: a.channels, scheduledAt: a.scheduledAt, sentAt: a.sentAt, createdAt: a.createdAt };
  }
}
