import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';

const s = schema;
const e = s.changelogEntries;
const DAY = 86_400_000;
const MAX_SCHEDULE_DAYS = 365;
export const PLAN_CODES = ['free', 'team_s', 'team_m', 'team_l', 'enterprise'] as const;

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `ยาวไม่เกิน ${max} ตัวอักษร`)
    .nullish()
    .transform((v) => (v ? v : null));

/**
 * ฟอร์มเขียน / แก้รายการ (U4) · action: draft = บันทึกร่าง · publish = เผยแพร่ทันที · schedule = ตั้งเวลา (publishAt)
 * รูป / วิดีโออยู่ในที่เก็บไฟล์สาธารณะ (https) แยกจากไฟล์ลูกค้า · ปุ่ม "ลองใช้" เป็นหน้าใน Workspace ปัจจุบัน (เริ่มด้วย /)
 */
export const EntryBody = z
  .object({
    kind: z.enum(s.CHANGELOG_KINDS),
    title: z.string().trim().min(1, 'กรอกหัวข้อ').max(120, 'หัวข้อยาวไม่เกิน 120 ตัวอักษร'),
    summary: z.string().trim().min(1, 'กรอกสรุปสั้น').max(140, 'สรุปสั้นยาวไม่เกิน 140 ตัวอักษร'),
    body: z.string().trim().max(10_000).default(''),
    titleEn: optText(120),
    summaryEn: optText(140),
    bodyEn: optText(10_000),
    mediaUrl: z
      .string()
      .trim()
      .max(500)
      .regex(/^https:\/\/\S+$/, 'ใช้ลิงก์ https ของที่เก็บไฟล์สาธารณะ')
      .nullish()
      .or(z.literal(''))
      .transform((v) => v || null),
    mediaKind: z.enum(['image', 'video']).nullish(),
    mediaAlt: optText(200),
    ctaLabel: optText(40),
    ctaLabelEn: optText(40),
    ctaPath: z
      .string()
      .trim()
      .max(200)
      .regex(/^\/(?!\/)[^\s]*$/, 'ใส่หน้าใน Workspace ที่ขึ้นต้นด้วย / เช่น /profile?tab=notify')
      .nullish()
      .or(z.literal(''))
      .transform((v) => v || null),
    audience: z.enum(s.CHANGELOG_AUDIENCES).default('all'),
    audiencePlans: z.array(z.enum(PLAN_CODES)).max(PLAN_CODES.length).default([]),
    audienceFlag: optText(63),
    spotlight: z.boolean().default(false),
    showPublic: z.boolean().default(true),
    displayDate: z.iso.date().nullish(),
    action: z.enum(['draft', 'publish', 'schedule']),
    publishAt: z.iso.datetime({ offset: true }).nullish(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.audience === 'plans' && !b.audiencePlans.length) ctx.addIssue({ code: 'custom', path: ['audiencePlans'], message: 'เลือกแพ็กเกจอย่างน้อย 1 แพ็กเกจ' });
    if (b.audience === 'flag' && !b.audienceFlag) ctx.addIssue({ code: 'custom', path: ['audienceFlag'], message: 'เลือก Feature flag' });
    if (!!b.ctaLabel !== !!b.ctaPath) ctx.addIssue({ code: 'custom', path: [b.ctaLabel ? 'ctaPath' : 'ctaLabel'], message: 'ปุ่ม "ลองใช้" ต้องมีทั้งข้อความและหน้าที่พาไป' });
    if (b.mediaUrl && !b.mediaAlt) ctx.addIssue({ code: 'custom', path: ['mediaAlt'], message: 'ใส่คำอธิบายรูปสำหรับโปรแกรมอ่านหน้าจอ' });
    if (b.action === 'schedule' && !b.publishAt) ctx.addIssue({ code: 'custom', path: ['publishAt'], message: 'เลือกเวลาเผยแพร่' });
  });
export const HideBody = z.object({ reason: z.string().trim().min(3, 'ใส่เหตุผลอย่างน้อย 3 ตัวอักษร').max(300) }).strict();

type EntryRow = typeof e.$inferSelect;
export type EntryInput = z.infer<typeof EntryBody>;

/** สถานะที่แสดง: ตั้งเวลาไว้และถึงเวลาแล้ว = เผยแพร่ (ลูกค้าเห็นทันทีผ่าน RLS ไม่มีงานเปลี่ยนสถานะ · O32) */
export const effectiveStatus = (r: Pick<EntryRow, 'status' | 'publishedAt'>, now = new Date()) =>
  r.status === 'scheduled' && r.publishedAt && r.publishedAt <= now ? 'published' : r.status;

/**
 * Changelog ของ Friday Ops (O33 · บอร์ด 17 แท็บ Changelog · U4 / U7)
 * - Owner เขียน / เผยแพร่ / ซ่อน · ทุกบทบาทอ่านได้ (วิศวกรอ่าน Changelog)
 * - Spotlight มีได้ทีละ 1 รายการในบรรดาที่ตั้งเวลา / เผยแพร่ (unique index) → ตั้งรายการใหม่ปลดรายการเดิมในธุรกรรมเดียวกัน
 * - ไม่ผูก Workspace จึงบันทึกเฉพาะ staff_audit_logs ทุกการสร้าง / แก้ / เผยแพร่ / ซ่อน
 */
@Injectable()
export class ChangelogService {
  constructor(@Inject(OPS_DB) private readonly db: Db) {}

  private async rows<T>(q: SQL) {
    const r = await this.db.execute(q);
    return ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as T[];
  }

  private async load(db: Db | Tx, id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบรายการ Changelog');
    const [row] = await db.select().from(e).where(eq(e.id, id));
    if (!row) throw new AppError(404, 'not_found', 'ไม่พบรายการ Changelog');
    return row;
  }

  /** ผู้ใช้ที่ใช้งานใน 30 วัน (ตัวหารของ "เห็นแล้ว %" และ "ผู้ใช้ที่เปิดอ่าน") */
  private async activeUsers30() {
    const [r] = await this.rows<{ n: number }>(sql`
      select count(distinct m.user_id)::int as n from workspace_members m join workspaces w on w.id = m.workspace_id
      where m.status = 'active' and m.role <> 'guest' and m.last_active_at > now() - interval '30 days' and w.deleted_at is null`);
    return r?.n ?? 0;
  }

  /** ตาราง + ตัวเลขบนหัวหน้า (KPI) */
  async list(now = new Date()) {
    const rows = await this.db
      .select({ e, views: s.changelogStats.views, clicks: s.changelogStats.clicks, by: s.staffUsers.name, devKey: s.devIssueLinks.issueKey })
      .from(e)
      .leftJoin(s.changelogStats, eq(s.changelogStats.entryId, e.id))
      .leftJoin(s.staffUsers, eq(s.staffUsers.id, e.createdBy))
      .leftJoin(s.devIssueLinks, eq(s.devIssueLinks.id, e.devIssueLinkId))
      .orderBy(sql`${e.publishedAt} desc nulls first`, desc(e.createdAt))
      .limit(500);
    const active = await this.activeUsers30();
    const flagKeys = [...new Set(rows.map((r) => r.e.audienceFlag).filter((k): k is string => !!k))];
    const flagWs = flagKeys.length ? await this.flagWorkspaces(flagKeys) : new Map<string, number>();
    const items = rows.map(({ e: r, views, clicks, by, devKey }) => {
      const v = views ?? 0;
      const c = clicks ?? 0;
      return {
        ...this.shape(r, now),
        views: v,
        clicks: c,
        viewPct: active > 0 ? Math.round((v / active) * 100) : null,
        clickPct: r.ctaPath && v > 0 ? Math.round((c / v) * 100) : null,
        flagWorkspaces: r.audienceFlag ? (flagWs.get(r.audienceFlag) ?? 0) : null,
        createdBy: by,
        devIssueKey: devKey,
      };
    });
    const since = now.getTime() - 30 * DAY;
    const recent = items.filter((i) => i.status === 'published' && i.publishedAt && new Date(i.publishedAt).getTime() >= since);
    const [readers] = await this.rows<{ n: number }>(sql`select count(*)::int as n from user_ui_states where whats_new_seen_at > now() - interval '30 days'`);
    const withCta = items.filter((i) => i.clickPct !== null);
    return {
      items,
      kpis: {
        published30: recent.length,
        byKind: { new: recent.filter((i) => i.kind === 'new').length, improved: recent.filter((i) => i.kind === 'improved').length, fixed: recent.filter((i) => i.kind === 'fixed').length },
        activeUsers30: active,
        readers30: readers?.n ?? 0,
        readersPct: active > 0 ? Math.min(100, Math.round(((readers?.n ?? 0) / active) * 100)) : null,
        clickPct: withCta.length ? Math.round(withCta.reduce((n, i) => n + i.clickPct!, 0) / withCta.length) : null,
      },
    };
  }

  /** จำนวน Workspace ที่ flag เปิดอยู่ (override ชนะค่าตั้งต้น) · แสดง "Workspace ที่เปิด flag (21)" */
  private async flagWorkspaces(keys: string[]) {
    const r = await this.rows<{ key: string; n: number }>(sql`
      select f.key, count(w.id)::int as n from feature_flags f
      cross join workspaces w
      left join feature_flag_overrides o on o.flag_id = f.id and o.workspace_id = w.id
      where f.key = any(${sql.param(keys)}::text[]) and w.deleted_at is null and coalesce(o.enabled, f.default_on)
      group by f.key`);
    return new Map(r.map((x) => [x.key, x.n]));
  }

  async one(id: string) {
    const [item] = (await this.list()).items.filter((i) => i.id === id);
    if (!item) throw new AppError(404, 'not_found', 'ไม่พบรายการ Changelog');
    return item;
  }

  private shape(r: EntryRow, now = new Date()) {
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      summary: r.summary,
      body: r.body,
      titleEn: r.titleEn,
      summaryEn: r.summaryEn,
      bodyEn: r.bodyEn,
      mediaUrl: r.mediaUrl,
      mediaKind: r.mediaKind,
      mediaAlt: r.mediaAlt,
      ctaLabel: r.ctaLabel,
      ctaLabelEn: r.ctaLabelEn,
      ctaPath: r.ctaPath,
      audience: r.audience,
      audiencePlans: r.audiencePlans,
      audienceFlag: r.audienceFlag,
      spotlight: r.spotlight,
      showPublic: r.showPublic,
      status: effectiveStatus(r, now),
      displayDate: r.displayDate,
      publishedAt: r.publishedAt,
      hiddenAt: r.hiddenAt,
      hideReason: r.hideReason,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  /** สถานะ / เวลาเผยแพร่ใหม่จาก action · รายการที่เผยแพร่แล้วแก้เนื้อหาได้ แต่ถอนเป็นร่าง / ตั้งเวลาใหม่ไม่ได้ (ใช้ "ซ่อน" แทน) */
  private schedule(input: EntryInput, cur: EntryRow | null, now: Date) {
    const live = cur && effectiveStatus(cur, now) === 'published';
    if (live && input.action !== 'publish') throw new AppError(409, 'already_published', 'รายการนี้เผยแพร่แล้ว · แก้เนื้อหาแล้วกดบันทึก หรือซ่อนรายการแทนการถอนเป็นร่าง');
    if (input.action === 'draft') return { status: 'draft' as const, publishedAt: null };
    if (input.action === 'publish') return { status: 'published' as const, publishedAt: live ? cur!.publishedAt : now };
    const at = new Date(input.publishAt!);
    if (at.getTime() <= now.getTime() + 60_000) throw new AppError(422, 'scheduled_in_past', 'เวลาเผยแพร่ต้องอยู่ในอนาคต (อย่างน้อย 1 นาที) · ถ้าต้องการเผยแพร่เลยให้เลือก "ทันที"');
    if (at.getTime() > now.getTime() + MAX_SCHEDULE_DAYS * DAY) throw new AppError(422, 'scheduled_too_far', `ตั้งเวลาล่วงหน้าได้ไม่เกิน ${MAX_SCHEDULE_DAYS} วัน`);
    return { status: 'scheduled' as const, publishedAt: at };
  }

  private async assertFlag(db: Db | Tx, input: EntryInput) {
    if (input.audience !== 'flag') return;
    const [f] = await db.select({ id: s.featureFlags.id }).from(s.featureFlags).where(eq(s.featureFlags.key, input.audienceFlag!));
    if (!f) throw new AppError(422, 'flag_not_found', `ไม่พบ Feature flag "${input.audienceFlag}"`);
  }

  private values(input: EntryInput) {
    return {
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      body: input.body,
      titleEn: input.titleEn,
      summaryEn: input.summaryEn,
      bodyEn: input.bodyEn,
      mediaUrl: input.mediaUrl,
      mediaKind: input.mediaUrl ? (input.mediaKind ?? 'image') : null,
      mediaAlt: input.mediaUrl ? input.mediaAlt : null,
      ctaLabel: input.ctaLabel,
      ctaLabelEn: input.ctaLabel ? input.ctaLabelEn : null,
      ctaPath: input.ctaPath,
      audience: input.audience,
      audiencePlans: input.audience === 'plans' ? [...new Set(input.audiencePlans)] : [],
      audienceFlag: input.audience === 'flag' ? input.audienceFlag : null,
      spotlight: input.spotlight,
      showPublic: input.showPublic,
      displayDate: input.displayDate ?? null,
    };
  }

  /** ปลด Spotlight ของรายการอื่น (ทีละ 1 รายการ) · คืนหัวข้อที่ถูกปลดไว้แจ้งในหน้า */
  private async takeSpotlight(tx: Tx, keep: string | null, status: string, spotlight: boolean) {
    if (!spotlight || status === 'draft') return null;
    const moved = await tx
      .update(e)
      .set({ spotlight: false })
      .where(and(eq(e.spotlight, true), inArray(e.status, ['scheduled', 'published']), keep ? ne(e.id, keep) : undefined))
      .returning({ title: e.title });
    return moved[0]?.title ?? null;
  }

  private what(status: string, at: Date | null) {
    if (status === 'draft') return 'บันทึกร่าง';
    if (status === 'scheduled') return `ตั้งเวลาเผยแพร่ ${at!.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' })}`;
    return 'เผยแพร่';
  }

  async create(staff: Staff, input: EntryInput, now = new Date()) {
    const when = this.schedule(input, null, now);
    const res = await this.db.transaction(async (tx) => {
      await this.assertFlag(tx, input);
      const moved = await this.takeSpotlight(tx, null, when.status, input.spotlight);
      const [row] = await tx
        .insert(e)
        .values({ ...this.values(input), ...when, createdBy: staff.id, updatedBy: staff.id })
        .returning({ id: e.id });
      await staffAudit(tx, staff, when.status === 'draft' ? 'ops.changelog_created' : 'ops.changelog_published', `${this.what(when.status, when.publishedAt)} "${input.title}"${moved ? ` · ย้าย Spotlight จาก "${moved}"` : ''}`, { type: 'changelog_entry', id: row.id });
      return { id: row.id, moved };
    });
    return { item: await this.one(res.id), spotlightMovedFrom: res.moved };
  }

  async update(staff: Staff, id: string, input: EntryInput, now = new Date()) {
    const res = await this.db.transaction(async (tx) => {
      const cur = await this.load(tx, id);
      const when = this.schedule(input, cur, now);
      await this.assertFlag(tx, input);
      const moved = await this.takeSpotlight(tx, id, when.status, input.spotlight);
      // ซ่อนแล้วเผยแพร่ / ตั้งเวลา / ร่างใหม่ = ล้างข้อมูลการซ่อน
      await tx.update(e).set({ ...this.values(input), ...when, hiddenAt: null, hiddenBy: null, hideReason: null, updatedBy: staff.id }).where(eq(e.id, id));
      const before = effectiveStatus(cur, now);
      const action = when.status === before ? 'ops.changelog_updated' : when.status === 'draft' ? 'ops.changelog_updated' : 'ops.changelog_published';
      const verb = when.status === before && before === 'published' ? 'แก้รายการที่เผยแพร่แล้ว' : this.what(when.status, when.publishedAt);
      await staffAudit(tx, staff, action, `${verb} "${input.title}"${moved ? ` · ย้าย Spotlight จาก "${moved}"` : ''}`, { type: 'changelog_entry', id });
      return moved;
    });
    return { item: await this.one(id), spotlightMovedFrom: res };
  }

  /** ซ่อน / ยกเลิกการเผยแพร่ (U7) · คนที่เปิดอ่านไปแล้วไม่ได้รับแจ้ง · ปลด Spotlight ไปด้วย */
  async hide(staff: Staff, id: string, input: z.infer<typeof HideBody>) {
    await this.db.transaction(async (tx) => {
      const cur = await this.load(tx, id);
      if (cur.status === 'hidden') throw new AppError(409, 'already_hidden', 'รายการนี้ถูกซ่อนไปแล้ว');
      await tx.update(e).set({ status: 'hidden', spotlight: false, hiddenAt: new Date(), hiddenBy: staff.id, hideReason: input.reason, updatedBy: staff.id }).where(eq(e.id, id));
      await staffAudit(tx, staff, 'ops.changelog_hidden', `ซ่อน "${cur.title}" · ${input.reason}`, { type: 'changelog_entry', id });
    });
    return this.one(id);
  }
}
