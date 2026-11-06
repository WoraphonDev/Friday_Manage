import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { defaultOn, isLocked, PREF_CHANNELS, PREF_EVENTS, PREF_ROWS, type PrefChannel } from './prefs-catalog.js';

const s = schema;
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'รูปแบบเวลา HH:MM');
const validZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const PatchMeBody = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    firstName: z.string().trim().max(80).nullable(),
    lastName: z.string().trim().max(80).nullable(),
    phone: z.string().trim().max(30).nullable(),
    about: z.string().trim().max(500).nullable(),
    avatarUrl: z.url().max(500).nullable(),
    locale: z.enum(['th', 'en']),
    yearFormat: z.enum(['BE', 'CE']),
    timezone: z.string().trim().min(1).max(64).refine(validZone, 'ไม่รู้จัก timezone นี้'),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'ต้องระบุค่าที่จะแก้');

export const WorkspaceQuery = z.object({ workspace: z.string().trim().min(1).max(63) });
export const PatchMembershipBody = z
  .object({
    jobTitle: z.string().trim().max(80).nullable(),
    department: z.string().trim().max(80).nullable(),
    capacityHoursWeek: z.number().int().min(0).max(80),
    workStart: Time.nullable(),
    workEnd: Time.nullable(),
    workDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'ต้องระบุค่าที่จะแก้');

export const PutPrefsBody = z.object({
  workspace: z.string().trim().min(1).max(63),
  prefs: z.array(z.object({ eventType: z.string().max(60), channel: z.enum(PREF_CHANNELS), enabled: z.boolean() })).max(200).default([]),
  /** true = ล้างที่ตั้งไว้ทั้งหมดกลับเป็นค่าเริ่มต้นก่อนบันทึก `prefs` */
  reset: z.boolean().default(false),
});
export const PutSettingsBody = z
  .object({
    dueReminder: z.enum(['1d_and_today', '3d', 'today_only']),
    digest: z.enum(['workdays', 'daily', 'off']),
    /** ช่วงงดส่ง Email / LINE · ส่งทั้งคู่เป็น null = ไม่งด */
    quietStart: Time.nullable(),
    quietEnd: Time.nullable(),
    quietOnHolidays: z.boolean(),
    autoWatch: z.boolean(),
  })
  .partial()
  .extend({ workspace: z.string().trim().min(1).max(63) })
  .refine((v) => Object.keys(v).length > 1, 'ต้องระบุค่าที่จะแก้');

/** ค่าเริ่มต้นเมื่อยังไม่เคยตั้ง · ช่วงงดส่งตรงกับที่ ChannelDispatcher (A25) ใช้เมื่อไม่มีแถว */
const SETTINGS_DEFAULT = { dueReminder: '1d_and_today', digest: 'workdays', quietStart: '20:00', quietEnd: '08:00', quietOnHolidays: true, autoWatch: true } as const;
const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);

/** I · Profile: ข้อมูลส่วนตัว, ตำแหน่ง / เวลาทำงานใน Workspace, ตารางแจ้งเตือน */
@Injectable()
export class ProfileService {
  constructor(
    private readonly db: TenantDb,
    @Inject(SYSTEM_DB) private readonly system: Db,
  ) {}

  // ---------------------------------------------------------------------------
  // me
  // ---------------------------------------------------------------------------
  async patchMe(auth: AuthInfo, body: z.infer<typeof PatchMeBody>) {
    // users ไม่มี RLS รายแถวสำหรับแก้ตัวเอง จึงเขียนด้วย SYSTEM_DB โดยล็อก id ของผู้เรียกเท่านั้น
    const [u] = await this.system
      .update(s.users)
      .set(body)
      .where(eq(s.users.id, auth.userId))
      .returning({
        id: s.users.id, email: s.users.email, displayName: s.users.displayName, firstName: s.users.firstName, lastName: s.users.lastName, phone: s.users.phone,
        about: s.users.about, avatarUrl: s.users.avatarUrl, locale: s.users.locale, yearFormat: s.users.yearFormat, timezone: s.users.timezone,
      });
    return u;
  }

  // ---------------------------------------------------------------------------
  // w/me/membership
  // ---------------------------------------------------------------------------
  async getMembership(auth: AuthInfo, tenant: TenantInfo) {
    return this.db.run(auth, tenant, async (tx) => {
      const [m] = await tx.select().from(s.workspaceMembers).where(eq(s.workspaceMembers.userId, auth.userId));
      const [ws] = await tx.select({ start: s.workspaceSettings.workStart, end: s.workspaceSettings.workEnd, days: s.workspaceSettings.workDays }).from(s.workspaceSettings);
      return {
        role: m!.role,
        jobTitle: m!.jobTitle,
        department: m!.department,
        capacityHoursWeek: m!.capacityHoursWeek,
        // null = ใช้เวลาทำงานของ Workspace
        workStart: hhmm(m!.workStart),
        workEnd: hhmm(m!.workEnd),
        workDays: m!.workDays,
        effective: { workStart: hhmm(m!.workStart ?? ws?.start ?? '09:30'), workEnd: hhmm(m!.workEnd ?? ws?.end ?? '18:30'), workDays: m!.workDays ?? ws?.days ?? [1, 2, 3, 4, 5] },
      };
    });
  }

  async patchMembership(auth: AuthInfo, tenant: TenantInfo, body: z.infer<typeof PatchMembershipBody>) {
    const current = await this.getMembership(auth, tenant);
    const start = body.workStart !== undefined ? body.workStart : current.workStart;
    const end = body.workEnd !== undefined ? body.workEnd : current.workEnd;
    if ((start === null) !== (end === null)) throw new AppError(400, 'invalid_input', 'ต้องระบุเวลาเริ่มและเวลาเลิกงานคู่กัน', { fields: [{ path: 'workStart', message: 'ระบุทั้งเวลาเริ่มและเลิกงาน หรือเว้นทั้งคู่' }] });
    if (start && end && start >= end) throw new AppError(400, 'invalid_input', 'เวลาเลิกงานต้องหลังเวลาเริ่มงาน', { fields: [{ path: 'workEnd', message: 'ต้องหลังเวลาเริ่ม' }] });
    // workspace_members ไม่มี policy ให้สมาชิกแก้แถวตัวเอง (กันแก้ role / status) จึงเขียนด้วย SYSTEM_DB
    // โดยแก้เฉพาะ 6 ฟิลด์ส่วนตัวของ (Workspace นี้, ผู้เรียก) ที่ผ่าน schema แล้วเท่านั้น
    await this.system
      .update(s.workspaceMembers)
      .set({ ...body, ...(body.workDays ? { workDays: [...new Set(body.workDays)].sort() } : {}) })
      .where(and(eq(s.workspaceMembers.workspaceId, tenant.workspaceId), eq(s.workspaceMembers.userId, auth.userId)));
    return this.getMembership(auth, tenant);
  }

  // ---------------------------------------------------------------------------
  // me/notification-prefs · me/notification-settings (ต่อ Workspace)
  // ---------------------------------------------------------------------------
  private matrix(stored: Array<{ eventType: string; channel: string; enabled: boolean }>) {
    const saved = new Map(stored.map((p) => [`${p.eventType}|${p.channel}`, p.enabled]));
    return PREF_ROWS.map((row) => ({
      eventType: row.eventType,
      group: row.group,
      label: row.label,
      hint: row.hint ?? null,
      channels: Object.fromEntries(
        PREF_CHANNELS.map((c) => [c, { enabled: isLocked(row.eventType, c) ? true : (saved.get(`${row.eventType}|${c}`) ?? defaultOn(row, c)), locked: isLocked(row.eventType, c), custom: saved.has(`${row.eventType}|${c}`) }]),
      ),
    }));
  }

  async getPrefs(auth: AuthInfo, workspaceSlug: string) {
    const tenant = await this.db.tenant(auth, workspaceSlug);
    const stored = await this.db.run(auth, tenant, (tx) =>
      tx.select({ eventType: s.userNotificationPrefs.eventType, channel: s.userNotificationPrefs.channel, enabled: s.userNotificationPrefs.enabled }).from(s.userNotificationPrefs).where(and(eq(s.userNotificationPrefs.workspaceId, tenant.workspaceId), eq(s.userNotificationPrefs.userId, auth.userId))),
    );
    return { workspace: tenant.slug, channels: PREF_CHANNELS, rows: this.matrix(stored) };
  }

  async putPrefs(auth: AuthInfo, body: z.infer<typeof PutPrefsBody>) {
    const tenant = await this.db.tenant(auth, body.workspace);
    for (const p of body.prefs) {
      if (!PREF_EVENTS.has(p.eventType)) throw new AppError(400, 'invalid_input', `ไม่รู้จักเหตุการณ์ ${p.eventType}`, { fields: [{ path: 'prefs.eventType', message: p.eventType }] });
      // Guest ไม่มี LINE ของ Workspace / ไม่ใช่ ช่องทางที่ล็อก
      if (isLocked(p.eventType, p.channel as PrefChannel) && !p.enabled) throw new AppError(400, 'locked_channel', 'ปิด In-app ของเหตุการณ์นี้ไม่ได้', { eventType: p.eventType, channel: p.channel });
    }
    await this.db.run(auth, tenant, async (tx) => {
      if (body.reset) await tx.delete(s.userNotificationPrefs).where(and(eq(s.userNotificationPrefs.workspaceId, tenant.workspaceId), eq(s.userNotificationPrefs.userId, auth.userId)));
      for (const p of body.prefs) {
        await tx
          .insert(s.userNotificationPrefs)
          .values({ workspaceId: tenant.workspaceId, userId: auth.userId, eventType: p.eventType, channel: p.channel, enabled: p.enabled })
          .onConflictDoUpdate({ target: [s.userNotificationPrefs.workspaceId, s.userNotificationPrefs.userId, s.userNotificationPrefs.eventType, s.userNotificationPrefs.channel], set: { enabled: p.enabled } });
      }
    });
    return this.getPrefs(auth, tenant.slug);
  }

  private settingsDto(r: typeof s.userNotificationSettings.$inferSelect | undefined) {
    if (!r) return { ...SETTINGS_DEFAULT, custom: false };
    return { dueReminder: r.dueReminder, digest: r.digest, quietStart: hhmm(r.quietStart), quietEnd: hhmm(r.quietEnd), quietOnHolidays: r.quietOnHolidays, autoWatch: r.autoWatch, custom: true };
  }

  async getSettings(auth: AuthInfo, workspaceSlug: string) {
    const tenant = await this.db.tenant(auth, workspaceSlug);
    const [r] = await this.db.run(auth, tenant, (tx) => tx.select().from(s.userNotificationSettings).where(and(eq(s.userNotificationSettings.workspaceId, tenant.workspaceId), eq(s.userNotificationSettings.userId, auth.userId))));
    return { workspace: tenant.slug, ...this.settingsDto(r) };
  }

  async putSettings(auth: AuthInfo, body: z.infer<typeof PutSettingsBody>) {
    const tenant = await this.db.tenant(auth, body.workspace);
    const { workspace: _w, ...rest } = body;
    await this.db.run(auth, tenant, async (tx) => {
      const [old] = await tx.select().from(s.userNotificationSettings).where(and(eq(s.userNotificationSettings.workspaceId, tenant.workspaceId), eq(s.userNotificationSettings.userId, auth.userId)));
      const base = this.settingsDto(old);
      const merged = { ...base, ...rest };
      if ((merged.quietStart === null) !== (merged.quietEnd === null)) throw new AppError(400, 'invalid_input', 'ต้องระบุเวลาเริ่มและสิ้นสุดช่วงงดส่งคู่กัน', { fields: [{ path: 'quietStart', message: 'ระบุทั้งคู่ หรือ null ทั้งคู่' }] });
      const values = { workspaceId: tenant.workspaceId, userId: auth.userId, dueReminder: merged.dueReminder, digest: merged.digest, quietStart: merged.quietStart, quietEnd: merged.quietEnd, quietOnHolidays: merged.quietOnHolidays, autoWatch: merged.autoWatch };
      await tx.insert(s.userNotificationSettings).values(values).onConflictDoUpdate({ target: [s.userNotificationSettings.workspaceId, s.userNotificationSettings.userId], set: values });
    });
    return this.getSettings(auth, tenant.slug);
  }
}

