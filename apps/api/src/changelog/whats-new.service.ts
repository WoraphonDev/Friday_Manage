import { Injectable } from '@nestjs/common';
import { schema, type Tx } from '@friday/db';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { Audience, eligibleTenant } from './audience.js';

const { changelogEntries: e, userUiStates: ui } = schema;

/** แผงแสดงรายการย้อนหลังกี่วัน (U1: "รายการเก่ากว่า 90 วันไม่แสดง") */
export const WHATS_NEW_DAYS = 90;
const LIMIT = 50;
const DAY = 86_400_000;

export const WorkspaceQuery = z.object({ workspace: z.string().trim().min(1, 'ระบุ Workspace') });
export const SeenBody = WorkspaceQuery.strict();

const notFound = () => new AppError(404, 'changelog_entry_not_found', 'ไม่พบรายการนี้');
const uuid = (id: string) => {
  if (!z.uuid().safeParse(id).success) throw notFound();
  return id;
};

/** คอลัมน์ที่ลูกค้าเห็น · ไม่ส่งข้อมูลภายใน (ผู้เขียน เหตุผลที่ซ่อน งานของทีมพัฒนา) */
const columns = {
  id: e.id,
  kind: e.kind,
  title: e.title,
  summary: e.summary,
  body: e.body,
  titleEn: e.titleEn,
  summaryEn: e.summaryEn,
  bodyEn: e.bodyEn,
  mediaUrl: e.mediaUrl,
  mediaKind: e.mediaKind,
  mediaAlt: e.mediaAlt,
  ctaLabel: e.ctaLabel,
  ctaLabelEn: e.ctaLabelEn,
  ctaPath: e.ctaPath,
  audience: e.audience,
  audiencePlans: e.audiencePlans,
  audienceFlag: e.audienceFlag,
  spotlight: e.spotlight,
  publishedAt: e.publishedAt,
  // วันที่ที่แสดง: ตั้งเองใน U4 หรือวันเผยแพร่ตามเวลาไทย
  date: sql<string>`coalesce(${e.displayDate}, (${e.publishedAt} at time zone 'Asia/Bangkok')::date)::text`,
};
type Row = Awaited<ReturnType<WhatsNewService['rows']>>[number];

/** รายการสำหรับแผงและ Spotlight · ฉบับอังกฤษส่งคู่กัน (ว่าง = เว็บแสดงฉบับไทย ตามคำตัดสิน W24) */
function shape(r: Row, seenAt: Date | null) {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    summary: r.summary,
    body: r.body,
    titleEn: r.titleEn,
    summaryEn: r.summaryEn,
    bodyEn: r.bodyEn,
    media: r.mediaUrl ? { url: r.mediaUrl, kind: r.mediaKind ?? 'image', alt: r.mediaAlt ?? '' } : null,
    cta: r.ctaPath && r.ctaLabel ? { label: r.ctaLabel, labelEn: r.ctaLabelEn, path: r.ctaPath } : null,
    date: r.date,
    publishedAt: r.publishedAt,
    spotlight: r.spotlight,
    unseen: !seenAt || (r.publishedAt?.getTime() ?? 0) > seenAt.getTime(),
  };
}

/**
 * มีอะไรใหม่ (U1) และ Spotlight (U2) ของแอปลูกค้า
 * - ลูกค้าอ่าน changelog_entries ผ่าน RLS ได้เฉพาะที่เผยแพร่แล้ว (รวมที่ตั้งเวลาไว้และถึงเวลาแล้ว) · กลุ่มผู้เห็นกรองที่นี่
 * - ยอดเห็น / คลิกเพิ่มผ่านฟังก์ชันของฐานข้อมูลเท่านั้น และไม่เก็บว่าใครอ่าน (ไม่ส่งเข้า product_events)
 */
@Injectable()
export class WhatsNewService {
  constructor(
    private readonly db: TenantDb,
    private readonly audience: Audience,
  ) {}

  private rows(tx: Tx) {
    return tx
      .select(columns)
      .from(e)
      .where(gte(e.publishedAt, sql`now() - make_interval(days => ${WHATS_NEW_DAYS})`))
      .orderBy(desc(e.publishedAt), desc(e.id))
      .limit(LIMIT);
  }

  private async state(tx: Tx, userId: string) {
    const [row] = await tx.select().from(ui).where(eq(ui.userId, userId));
    return row ?? null;
  }

  /** รายการที่ผู้ใช้นี้เห็นใน Workspace นี้ (ยังไม่ตัดตามที่เห็นแล้ว) */
  private async visible(tx: Tx, tenant: TenantInfo) {
    return this.audience.filter(tenant, await this.rows(tx));
  }

  /** GET me/whats-new · Guest / Workspace ที่ถูกระงับได้รายการว่างและ `hidden: true` (เว็บซ่อนปุ่ม) */
  async list(auth: AuthInfo, slug: string) {
    const tenant = await eligibleTenant(this.db, auth, slug);
    if (!tenant) return { items: [], unseen: 0, seenAt: null, hidden: true };
    return this.db.run(auth, tenant, async (tx) => {
      const seenAt = (await this.state(tx, auth.userId))?.whatsNewSeenAt ?? null;
      const items = (await this.visible(tx, tenant)).map((r) => shape(r, seenAt));
      return { items, unseen: items.filter((i) => i.unseen).length, seenAt, hidden: false };
    });
  }

  /**
   * POST me/whats-new/seen · เปิดแผง = เห็นทุกรายการในแผง (จุดเหลืองหาย)
   * นับยอดเห็นเฉพาะรายการที่ใหม่กว่าครั้งก่อนที่เปิด จึงนับได้ราว 1 ครั้งต่อคนต่อรายการ (ไม่เก็บรายชื่อคนอ่าน)
   */
  async seen(auth: AuthInfo, slug: string) {
    const tenant = await eligibleTenant(this.db, auth, slug);
    if (!tenant) return { seenAt: null, counted: 0 };
    return this.db.run(auth, tenant, async (tx) => {
      const before = (await this.state(tx, auth.userId))?.whatsNewSeenAt ?? null;
      const fresh = (await this.visible(tx, tenant)).filter((r) => !before || (r.publishedAt?.getTime() ?? 0) > before.getTime()).map((r) => r.id);
      if (fresh.length) await tx.execute(sql`select app.count_changelog_views(${sql.param(fresh)}::uuid[])`);
      const [row] = await tx
        .insert(ui)
        .values({ userId: auth.userId, whatsNewSeenAt: sql`now()` })
        .onConflictDoUpdate({ target: ui.userId, set: { whatsNewSeenAt: sql`now()`, updatedAt: sql`now()` } })
        .returning({ seenAt: ui.whatsNewSeenAt });
      return { seenAt: row.seenAt, counted: fresh.length };
    });
  }

  /** POST me/whats-new/{id}/click · กดปุ่ม "ลองใช้" (แผงหรือ Spotlight) · นับเฉพาะรายการที่เผยแพร่แล้ว */
  async click(auth: AuthInfo, id: string) {
    uuid(id);
    return this.db.run(auth, null, async (tx) => {
      const [hit] = await tx.select({ id: e.id }).from(e).where(eq(e.id, id));
      if (!hit) throw notFound();
      await tx.execute(sql`select app.count_changelog_click(${id}::uuid)`);
      return { id, clicked: true };
    });
  }

  /**
   * GET me/spotlight · Spotlight ที่ยังไม่เห็นได้ไม่เกิน 1 รายการ (ทีม Friday ตั้งได้ทีละ 1 รายการอยู่แล้ว)
   * ไม่แสดงในวันแรกที่สมัคร ให้ Onboarding (V1) ทำงานก่อน · เงื่อนไขอื่น (กำลังพิมพ์ / เปิด Drawer / 3 วินาที) ตัดสินที่เว็บ
   */
  async spotlight(auth: AuthInfo, slug: string) {
    const tenant = await eligibleTenant(this.db, auth, slug);
    if (!tenant) return { item: null };
    return this.db.run(auth, tenant, async (tx) => {
      const [user] = await tx.select({ createdAt: schema.users.createdAt }).from(schema.users).where(eq(schema.users.id, auth.userId));
      if (user && Date.now() - user.createdAt.getTime() < DAY) return { item: null };
      const state = await this.state(tx, auth.userId);
      const seen = new Set(state?.spotlightSeenIds ?? []);
      const candidates = (await tx.select(columns).from(e).where(and(eq(e.spotlight, true), gte(e.publishedAt, sql`now() - make_interval(days => ${WHATS_NEW_DAYS})`))).orderBy(desc(e.publishedAt))).filter((r) => !seen.has(r.id));
      const [item] = await this.audience.filter(tenant, candidates);
      return { item: item ? shape(item, state?.whatsNewSeenAt ?? null) : null };
    });
  }

  /**
   * POST me/spotlight/{id}/dismiss · ปิดด้วย Esc / X / ไว้ทีหลัง / ปุ่มหลัก = เห็นแล้ว ไม่แสดงอีก
   * บันทึกวันที่เห็น (NPS ไม่ถามในวันเดียวกัน) และนับเป็นการเห็นรายการ 1 ครั้ง
   */
  async dismissSpotlight(auth: AuthInfo, id: string) {
    uuid(id);
    return this.db.run(auth, null, async (tx) => {
      const [hit] = await tx.select({ id: e.id }).from(e).where(and(eq(e.id, id), eq(e.spotlight, true)));
      if (!hit) throw notFound();
      const state = await this.state(tx, auth.userId);
      const already = state?.spotlightSeenIds.includes(id) ?? false;
      if (!already) await tx.execute(sql`select app.count_changelog_views(${sql.param([id])}::uuid[])`);
      // เก็บแค่ 20 รายการล่าสุด พอสำหรับ Spotlight ในช่วง 90 วัน
      const ids = already ? state!.spotlightSeenIds : [id, ...(state?.spotlightSeenIds ?? [])].slice(0, 20);
      await tx
        .insert(ui)
        .values({ userId: auth.userId, spotlightSeenIds: ids, spotlightSeenAt: sql`now()` })
        .onConflictDoUpdate({ target: ui.userId, set: { spotlightSeenIds: ids, spotlightSeenAt: sql`now()`, updatedAt: sql`now()` } });
      return { id, dismissed: true };
    });
  }
}
