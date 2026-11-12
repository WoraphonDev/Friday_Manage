import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { asc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { staffAudit } from '../audit.js';
import { has, type Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';

const s = schema;
const a = s.helpArticles;
type Row = Record<string, unknown>;
type ArticleRow = typeof a.$inferSelect;

/** "ต้องทบทวน" เมื่อช่วยได้ต่ำกว่า 70% จากอย่างน้อย 20 โหวต (คำตัดสิน O35) */
export const LOW_HELPFUL_PCT = 70;
export const MIN_VOTES = 20;
/** เก็บคำค้นที่ไม่พบ 25 เดือนเท่า product_events (O32) แล้วลบ */
export const MISS_RETENTION_MONTHS = 25;

const SLUG = /^[a-z0-9][a-z0-9-]{1,79}$/;
const Route = z.string().trim().regex(/^[a-z0-9][a-z0-9.-]{0,40}$/, 'รูปแบบหน้าไม่ถูกต้อง');
const Fields = {
  slug: z.string().trim().toLowerCase().regex(SLUG, 'ที่อยู่ใช้ a-z 0-9 และ - (2–80 ตัว)'),
  categoryId: z.uuid(),
  title: z.string().trim().min(3, 'หัวข้ออย่างน้อย 3 ตัวอักษร').max(200),
  summary: z.string().trim().max(300).nullable(),
  body: z.string().max(50_000),
  titleEn: z.string().trim().max(200).nullable(),
  summaryEn: z.string().trim().max(300).nullable(),
  bodyEn: z.string().max(50_000).nullable(),
  visibility: z.enum(s.HELP_VISIBILITIES),
  appRoutes: z.array(Route).max(20),
  keywords: z.string().trim().max(500).nullable(),
  reviewAt: z.iso.date().nullable(),
  ownerId: z.uuid().nullable(),
};
export const CreateBody = z
  .object({
    title: Fields.title,
    categoryId: Fields.categoryId,
    slug: Fields.slug.optional(),
    summary: Fields.summary.optional(),
    body: Fields.body.optional(),
    visibility: Fields.visibility.optional(),
    appRoutes: Fields.appRoutes.optional(),
    keywords: Fields.keywords.optional(),
    reviewAt: Fields.reviewAt.optional(),
    /** เขียนตอบคำค้นที่ไม่พบ (การ์ด "คำค้นที่ไม่พบบ่อย") · ผูก help_search_misses.article_id */
    fromQuery: z.string().trim().max(200).optional(),
  })
  .strict();
export const PatchBody = z.object(Object.fromEntries(Object.entries(Fields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof Fields]: z.ZodOptional<(typeof Fields)[K]> }).strict();
export const PublishBody = z.object({ piiChecked: z.boolean() }).strict();
export const ListQuery = z.object({
  status: z.enum(['all', 'published', 'draft', 'archived']).default('all'),
  lowHelpful: z.stringbool().default(false),
  review: z.stringbool().default(false),
  category: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
});
export const MissesQuery = z.object({ days: z.coerce.number().int().min(1).max(400).default(30) });
export const CategoriesBody = z
  .object({
    items: z
      .array(z.object({ id: z.uuid().optional(), name: z.string().trim().min(2).max(60), nameEn: z.string().trim().max(60).nullable().optional(), slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}$/).optional() }).strict())
      .min(1)
      .max(40),
  })
  .strict();
export const FromTicketBody = z.object({ title: Fields.title, categoryId: Fields.categoryId, body: Fields.body, link: z.boolean().default(true) }).strict();

/** ฟิลด์ที่ลูกค้าเห็น · แก้บทความที่เผยแพร่แล้วเก็บลงร่าง (draft) ก่อน · reviewAt / ownerId เป็นข้อมูลภายในแก้ตรงได้เลย */
const PUBLIC_FIELDS = ['slug', 'categoryId', 'title', 'summary', 'body', 'titleEn', 'summaryEn', 'bodyEn', 'visibility', 'appRoutes', 'keywords'] as const;
type Draft = Partial<Record<(typeof PUBLIC_FIELDS)[number], unknown>>;

/** หมวด Ticket (O22) → หมวดของศูนย์ช่วยเหลือที่ seed ไว้ (O32) ใช้เดาหมวดตอนสร้างบทความจาก Ticket */
const TICKET_TO_CATEGORY: Record<string, string> = {
  how_to: 'getting-started', import: 'import-export', notification: 'notifications', api: 'api-integrations',
  billing: 'billing', tax_invoice: 'billing', payment: 'billing', account: 'members-permissions', bug: 'projects-issues',
};

const rowsOf = <T = Row>(r: unknown) => ((r as { rows?: unknown[] }).rows ?? (r as unknown[])) as T[];
const pct = (n: number, d: number) => (d > 0 ? Math.round((100 * n) / d) : null);

/**
 * O35 · จัดการบทความศูนย์ช่วยเหลือ (19 · 19b · X8 · X9)
 * Owner และ Support เขียนและเผยแพร่ได้ · บทบาทอื่นอ่านอย่างเดียว · Audit ทุกการเผยแพร่ / แก้ / ลบ (staff_audit_logs)
 * ร่างของบทความที่เผยแพร่แล้วเก็บใน help_articles.draft ซึ่ง friday_app ไม่ได้ grant จึงไม่หลุดถึงลูกค้า
 */
@Injectable()
export class HelpService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OpsHelp');
  private timer?: NodeJS.Timeout;

  constructor(@Inject(OPS_DB) private readonly db: Db) {}

  onModuleInit() {
    // ลบคำค้นที่ไม่พบเกิน 25 เดือนวันละครั้ง (O32 ฝากไว้) · test เรียก purgeMisses() เอง
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      this.timer = setInterval(() => void this.purgeMisses().catch((e) => this.log.error(String(e))), 86_400_000);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async purgeMisses() {
    const r = await this.db.execute(sql`delete from help_search_misses where day < (now() at time zone 'Asia/Bangkok')::date - make_interval(months => ${MISS_RETENTION_MONTHS})`);
    return { deleted: (r as unknown as { rowCount?: number }).rowCount ?? 0 };
  }

  private canEdit = (staff: Staff) => has(staff, 'owner', 'support');

  private async rows<T = Row>(q: SQL) {
    return rowsOf<T>(await this.db.execute(q));
  }

  private async find(id: string, tx: Db | Tx = this.db) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบบทความ');
    const [r] = await tx.select().from(a).where(eq(a.id, id));
    if (!r) throw new AppError(404, 'not_found', 'ไม่พบบทความ');
    return r;
  }

  private async category(id: string) {
    const [c] = await this.db.select().from(s.helpCategories).where(eq(s.helpCategories.id, id));
    if (!c) throw new AppError(422, 'category_invalid', 'ไม่พบหมวดที่เลือก');
    return c;
  }

  /** slug ว่างได้จากหัวข้อภาษาอังกฤษ · หัวข้อภาษาไทยล้วนใช้ article-xxxx · ซ้ำต่อท้ายตัวเลข */
  private async uniqueSlug(base: string | undefined, title: string, except?: string) {
    let slug = base ?? title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    if (!SLUG.test(slug)) slug = `article-${randomBytes(3).toString('hex')}`;
    for (let i = 0; i < 50; i++) {
      const candidate = i ? `${slug.slice(0, 74)}-${i + 1}` : slug;
      const [hit] = await this.db.select({ id: a.id }).from(a).where(eq(a.slug, candidate));
      if (!hit || hit.id === except) return candidate;
      if (base && !i) throw new AppError(409, 'slug_taken', 'ที่อยู่นี้มีบทความอื่นใช้แล้ว');
    }
    return `${slug.slice(0, 70)}-${randomBytes(3).toString('hex')}`;
  }

  /** ค่าที่แสดงในตัวแก้ = ฉบับที่เผยแพร่ทับด้วยร่างที่ยังไม่เผยแพร่ */
  private edit(r: ArticleRow) {
    const d = (r.draft ?? {}) as Draft;
    return {
      id: r.id, slug: (d.slug as string) ?? r.slug, status: r.status, categoryId: (d.categoryId as string) ?? r.categoryId,
      title: (d.title as string) ?? r.title, summary: 'summary' in d ? (d.summary as string | null) : r.summary, body: (d.body as string) ?? r.body,
      titleEn: 'titleEn' in d ? (d.titleEn as string | null) : r.titleEn, summaryEn: 'summaryEn' in d ? (d.summaryEn as string | null) : r.summaryEn, bodyEn: 'bodyEn' in d ? (d.bodyEn as string | null) : r.bodyEn,
      visibility: (d.visibility as string) ?? r.visibility, appRoutes: (d.appRoutes as string[]) ?? r.appRoutes, keywords: 'keywords' in d ? (d.keywords as string | null) : r.keywords,
      reviewAt: r.reviewAt, ownerId: r.ownerId, piiCheckedAt: r.piiCheckedAt, version: r.version, publishedAt: r.publishedAt,
      draftSavedAt: r.draftSavedAt, hasDraft: !!r.draft, updatedAt: r.updatedAt,
    };
  }

  // ── ภาพรวม / รายการ ───────────────────────────────────

  /** สถิติต่อบทความ: อ่าน 30 วัน · โหวต · ช่วยได้ % · Ticket ที่อ้างถึง */
  private stats = sql`
    select a.id, a.slug, a.title, a.status, a.updated_at as "updatedAt", a.review_at as "reviewAt", (a.draft is not null) as "hasDraft",
      json_build_object('id', c.id, 'name', c.name) as category,
      case when st.id is null then null else json_build_object('id', st.id, 'name', st.name) end as owner,
      coalesce((select sum(v.views) from help_article_views v where v.article_id = a.id and v.day > (now() at time zone 'Asia/Bangkok')::date - 30), 0)::int as "reads30",
      (select count(*) from help_feedback f where f.article_id = a.id)::int as votes,
      (select count(*) from help_feedback f where f.article_id = a.id and f.helpful)::int as helpful,
      (select count(*) from help_article_tickets x where x.article_id = a.id)::int as tickets
    from help_articles a join help_categories c on c.id = a.category_id left join staff_users st on st.id = a.owner_id`;

  private review(r: { status: string; reviewAt: string | null; votes: number; helpful: number }) {
    if (r.status !== 'published') return null;
    const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
    if (r.reviewAt && r.reviewAt < today) return 'overdue' as const;
    if (r.votes >= MIN_VOTES && (100 * r.helpful) / r.votes < LOW_HELPFUL_PCT) return 'low_helpful' as const;
    return null;
  }

  private async allRows() {
    const list = await this.rows<{ id: string; slug: string; title: string; status: string; updatedAt: Date; reviewAt: string | null; hasDraft: boolean; category: { id: string; name: string }; owner: { id: string; name: string } | null; reads30: number; votes: number; helpful: number; tickets: number }>(
      sql`${this.stats} order by a.updated_at desc`,
    );
    return list.map((r) => {
      const reason = this.review(r);
      return { id: r.id, slug: r.slug, title: r.title, category: r.category, status: r.status, needsReview: !!reason, reviewReason: reason, reads30: r.reads30, helpfulPct: pct(r.helpful, r.votes), votes: r.votes, tickets: r.tickets, updatedAt: r.updatedAt, owner: r.owner, hasDraft: r.hasDraft };
    });
  }

  async list(q: z.infer<typeof ListQuery>) {
    let items = await this.allRows();
    if (q.status !== 'all') items = items.filter((r) => r.status === q.status);
    if (q.lowHelpful) items = items.filter((r) => r.helpfulPct !== null && r.helpfulPct < LOW_HELPFUL_PCT);
    if (q.review) items = items.filter((r) => r.needsReview);
    if (q.category) items = items.filter((r) => r.category.id === q.category);
    if (q.q) {
      const needle = q.q.toLowerCase();
      items = items.filter((r) => r.title.toLowerCase().includes(needle) || r.slug.includes(needle));
    }
    return { items };
  }

  private async missList(days: number) {
    return this.rows<{ query: string; searches: number; tickets: number; articleId: string | null; articleTitle: string | null; lastDay: string }>(sql`
      select m.query, sum(m.searches)::int as searches, sum(m.tickets)::int as tickets,
        (array_agg(m.article_id) filter (where m.article_id is not null))[1] as "articleId",
        (select a.title from help_articles a where a.id = (array_agg(m.article_id) filter (where m.article_id is not null))[1]) as "articleTitle",
        max(m.day)::text as "lastDay"
      from help_search_misses m
      where m.day > (now() at time zone 'Asia/Bangkok')::date - ${days}::int
      group by m.query order by sum(m.searches) desc, max(m.day) desc limit 200`);
  }

  async misses(q: z.infer<typeof MissesQuery>) {
    return { items: await this.missList(q.days) };
  }

  /**
   * KPI หน้า 19 · "ค้นแล้วไม่เปิด Ticket" ประมาณจาก Ticket ในแอป 30 วันเทียบจำนวนค้นหา
   * (ไม่เก็บว่าใครค้น จึงจับคู่การค้นกับ Ticket รายคนไม่ได้ · ตามคำตัดสิน A44 / O32)
   */
  async overview(staff: Staff) {
    const items = await this.allRows();
    const [st] = await this.rows<{ searches: number; misses: number }>(sql`
      select coalesce(sum(searches), 0)::int as searches, coalesce(sum(misses), 0)::int as misses from help_search_stats where day > (now() at time zone 'Asia/Bangkok')::date - 30`);
    const [fb] = await this.rows<{ votes: number; helpful: number }>(sql`
      select count(*)::int as votes, (count(*) filter (where helpful))::int as helpful from help_feedback where created_at > now() - interval '30 days'`);
    const [tk] = await this.rows<{ n: number }>(sql`select count(*)::int as n from support_tickets where channel = 'in_app' and created_at > now() - interval '30 days'`);
    const misses = await this.missList(30);
    const open = misses.filter((m) => !m.articleId);
    const searches = st?.searches ?? 0;
    const review = items.filter((r) => r.needsReview).length;
    return {
      kpi: {
        published: items.filter((r) => r.status === 'published').length,
        review,
        drafts: items.filter((r) => r.status === 'draft').length,
        searches30: searches,
        misses30: st?.misses ?? 0,
        missPct: pct(st?.misses ?? 0, searches),
        deflectionPct: searches ? Math.max(0, Math.min(100, 100 - (pct(tk?.n ?? 0, searches) ?? 0))) : null,
        helpfulPct: pct(fb?.helpful ?? 0, fb?.votes ?? 0),
        votes30: fb?.votes ?? 0,
      },
      tabs: { articles: items.length, misses: open.length, review },
      topMisses: open.slice(0, 4).map((m) => ({ query: m.query, searches: m.searches, tickets: m.tickets, articleId: null })),
      canEdit: this.canEdit(staff),
    };
  }

  async get(staff: Staff, id: string) {
    const r = await this.find(id);
    const versions = await this.rows<{ version: number; publishedAt: Date; publishedBy: string | null }>(sql`
      select v.version, v.created_at as "publishedAt", st.name as "publishedBy" from help_article_versions v left join staff_users st on st.id = v.published_by
      where v.article_id = ${r.id} order by v.version desc`);
    const [ticket] = r.sourceTicketId ? await this.db.select({ id: s.supportTickets.id, number: s.supportTickets.number }).from(s.supportTickets).where(eq(s.supportTickets.id, r.sourceTicketId)) : [];
    return { article: this.edit(r), versions, sourceTicket: ticket ?? null, canEdit: this.canEdit(staff) };
  }

  // ── เขียน ─────────────────────────────────────────────

  async create(staff: Staff, input: z.infer<typeof CreateBody>, extra: { sourceTicketId?: string } = {}) {
    await this.category(input.categoryId);
    const slug = await this.uniqueSlug(input.slug, input.title);
    const article = await this.db.transaction(async (tx) => {
      const [r] = await tx
        .insert(a)
        .values({
          slug, categoryId: input.categoryId, title: input.title, summary: input.summary ?? null, body: input.body ?? '',
          visibility: input.visibility ?? 'public', appRoutes: input.appRoutes ?? [], keywords: input.keywords ?? null, reviewAt: input.reviewAt ?? null,
          ownerId: staff.id, sourceTicketId: extra.sourceTicketId ?? null, createdBy: staff.id, updatedBy: staff.id, draftSavedAt: new Date(),
        })
        .returning();
      if (input.fromQuery) await tx.execute(sql`update help_search_misses set article_id = ${r.id} where query = app.help_search_key(${input.fromQuery}) and article_id is null`);
      await staffAudit(tx, staff, 'help.article_created', `สร้างร่างบทความ "${r.title}"${input.fromQuery ? ` จากคำค้น "${input.fromQuery}"` : ''}`, { type: 'help_article', id: r.id });
      return r;
    });
    return { article: this.edit(article) };
  }

  /**
   * บันทึกอัตโนมัติ (19b) · ร่างแก้คอลัมน์หลักได้เลย (ลูกค้าไม่เห็นร่าง) · ที่เผยแพร่แล้วเก็บลงร่างจนกดเผยแพร่
   * Audit "แก้" ไม่เกิน 1 รายการต่อคนต่อบทความทุก 15 นาที (บันทึกอัตโนมัติยิงถี่)
   */
  async patch(staff: Staff, id: string, input: z.infer<typeof PatchBody>) {
    const cur = await this.find(id);
    if (input.categoryId) await this.category(input.categoryId);
    if (input.ownerId) {
      const [o] = await this.db.select({ id: s.staffUsers.id }).from(s.staffUsers).where(eq(s.staffUsers.id, input.ownerId));
      if (!o) throw new AppError(422, 'owner_invalid', 'ไม่พบพนักงานที่เลือก');
    }
    if (input.slug && input.slug !== cur.slug) await this.uniqueSlug(input.slug, cur.title, cur.id);
    const now = new Date();
    const internal = { ...(input.reviewAt !== undefined ? { reviewAt: input.reviewAt } : {}), ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}) };
    const pub = Object.fromEntries(PUBLIC_FIELDS.filter((f) => input[f] !== undefined).map((f) => [f, input[f]])) as Draft;
    const next = await this.db.transaction(async (tx) => {
      const set =
        cur.status === 'draft'
          ? { ...pub, ...internal, draftSavedAt: now, updatedBy: staff.id }
          : { ...internal, ...(Object.keys(pub).length ? { draft: { ...((cur.draft ?? {}) as Draft), ...pub }, draftSavedAt: now } : {}), updatedBy: staff.id };
      const [r] = await tx.update(a).set(set as Partial<ArticleRow>).where(eq(a.id, cur.id)).returning();
      const [recent] = await this.rows<{ n: number }>(sql`
        select count(*)::int as n from staff_audit_logs where staff_id = ${staff.id} and action = 'help.article_edited' and target_id = ${cur.id} and created_at > now() - interval '15 minutes'`);
      if (!recent?.n) await staffAudit(tx, staff, 'help.article_edited', `แก้บทความ "${r.title}"${cur.status === 'draft' ? '' : ' (ร่างที่ยังไม่เผยแพร่)'}`, { type: 'help_article', id: r.id });
      return r;
    });
    return { savedAt: now, article: this.edit(next) };
  }

  /** เผยแพร่ (ต้องติ๊ก "ตรวจแล้วไม่มีข้อมูลลูกค้า") · คัดร่างเข้าคอลัมน์หลัก + เก็บเวอร์ชัน */
  async publish(staff: Staff, id: string, input: z.infer<typeof PublishBody>) {
    if (!input.piiChecked) throw new AppError(422, 'pii_check_required', 'ติ๊ก "ตรวจแล้วไม่มีข้อมูลลูกค้า" ก่อนเผยแพร่');
    const cur = await this.find(id);
    const e = this.edit(cur);
    if (!e.body.trim()) throw new AppError(422, 'body_required', 'ใส่เนื้อหาก่อนเผยแพร่');
    if (e.slug !== cur.slug) await this.uniqueSlug(e.slug, e.title, cur.id);
    const r = await this.db.transaction(async (tx) => {
      const version = cur.version + 1;
      const now = new Date();
      const [row] = await tx
        .update(a)
        .set({
          slug: e.slug, categoryId: e.categoryId, title: e.title, summary: e.summary, body: e.body, titleEn: e.titleEn, summaryEn: e.summaryEn, bodyEn: e.bodyEn,
          visibility: e.visibility, appRoutes: e.appRoutes, keywords: e.keywords, status: 'published', version, publishedAt: now,
          piiCheckedAt: now, piiCheckedBy: staff.id, draft: null, draftSavedAt: null, updatedBy: staff.id,
        })
        .where(eq(a.id, cur.id))
        .returning();
      await tx.insert(s.helpArticleVersions).values({ articleId: cur.id, version, categoryId: e.categoryId, title: e.title, summary: e.summary, body: e.body, titleEn: e.titleEn, summaryEn: e.summaryEn, bodyEn: e.bodyEn, visibility: e.visibility, appRoutes: e.appRoutes, keywords: e.keywords, publishedBy: staff.id });
      await staffAudit(tx, staff, 'help.article_published', `เผยแพร่บทความ "${e.title}" เวอร์ชัน ${version} · ${e.visibility === 'public' ? 'ทุกคน' : 'เฉพาะผู้เข้าสู่ระบบ'}`, { type: 'help_article', id: cur.id });
      return row;
    });
    return { article: this.edit(r) };
  }

  /** ย้อนกลับ = เผยแพร่เนื้อหาของเวอร์ชันเดิมเป็นเวอร์ชันใหม่ (ประวัติไม่หาย) */
  async restore(staff: Staff, id: string, version: number) {
    const cur = await this.find(id);
    const [v] = await this.db.select().from(s.helpArticleVersions).where(sql`${s.helpArticleVersions.articleId} = ${cur.id} and ${s.helpArticleVersions.version} = ${version}`);
    if (!v) throw new AppError(404, 'version_not_found', 'ไม่พบเวอร์ชันนี้');
    const categoryId = v.categoryId && (await this.db.select({ id: s.helpCategories.id }).from(s.helpCategories).where(eq(s.helpCategories.id, v.categoryId)))[0] ? v.categoryId : cur.categoryId;
    const r = await this.db.transaction(async (tx) => {
      const next = cur.version + 1;
      const now = new Date();
      const [row] = await tx
        .update(a)
        .set({ categoryId, title: v.title, summary: v.summary, body: v.body, titleEn: v.titleEn, summaryEn: v.summaryEn, bodyEn: v.bodyEn, visibility: v.visibility, appRoutes: v.appRoutes, keywords: v.keywords, status: 'published', version: next, publishedAt: now, piiCheckedAt: now, piiCheckedBy: staff.id, draft: null, draftSavedAt: null, updatedBy: staff.id })
        .where(eq(a.id, cur.id))
        .returning();
      await tx.insert(s.helpArticleVersions).values({ articleId: cur.id, version: next, categoryId, title: v.title, summary: v.summary, body: v.body, titleEn: v.titleEn, summaryEn: v.summaryEn, bodyEn: v.bodyEn, visibility: v.visibility, appRoutes: v.appRoutes, keywords: v.keywords, publishedBy: staff.id });
      await staffAudit(tx, staff, 'help.article_restored', `ย้อนบทความ "${v.title}" กลับเป็นเวอร์ชัน ${version} (เผยแพร่เป็นเวอร์ชัน ${next})`, { type: 'help_article', id: cur.id });
      return row;
    });
    return { article: this.edit(r) };
  }

  /** เก็บเข้าคลัง: ลูกค้าไม่เห็นแล้ว (เผยแพร่ใหม่ได้) */
  async archive(staff: Staff, id: string) {
    const cur = await this.find(id);
    if (cur.status === 'archived') throw new AppError(409, 'already_archived', 'บทความนี้เก็บเข้าคลังแล้ว');
    const [r] = await this.db.update(a).set({ status: 'archived', updatedBy: staff.id }).where(eq(a.id, cur.id)).returning();
    await staffAudit(this.db, staff, 'help.article_archived', `เก็บบทความ "${cur.title}" เข้าคลัง (ลูกค้าไม่เห็น)`, { type: 'help_article', id: cur.id });
    return { article: this.edit(r) };
  }

  /** ทิ้งร่างที่ยังไม่เผยแพร่ของบทความที่เผยแพร่แล้ว */
  async discardDraft(staff: Staff, id: string) {
    const cur = await this.find(id);
    if (!cur.draft) throw new AppError(409, 'no_draft', 'ไม่มีร่างที่ยังไม่เผยแพร่');
    const [r] = await this.db.update(a).set({ draft: null, draftSavedAt: null, updatedBy: staff.id }).where(eq(a.id, cur.id)).returning();
    await staffAudit(this.db, staff, 'help.draft_discarded', `ทิ้งร่างของบทความ "${cur.title}"`, { type: 'help_article', id: cur.id });
    return { article: this.edit(r) };
  }

  async remove(staff: Staff, id: string) {
    const cur = await this.find(id);
    await this.db.transaction(async (tx) => {
      await tx.delete(a).where(eq(a.id, cur.id));
      await staffAudit(tx, staff, 'help.article_deleted', `ลบบทความ "${cur.title}" (/help/${cur.slug}) · เคยเผยแพร่ ${cur.version} เวอร์ชัน`, { type: 'help_article', id: cur.id });
    });
    return { deleted: true };
  }

  // ── หมวด (X9) ─────────────────────────────────────────

  async categories() {
    const items = await this.rows(sql`
      select c.id, c.slug, c.name, c.name_en as "nameEn", c.position, (select count(*) from help_articles a where a.category_id = c.id)::int as articles
      from help_categories c order by c.position, c.name`);
    return { items };
  }

  /** บันทึกทั้งชุดตามลำดับ · หมวดที่หายจากรายการ = ลบ (ได้เมื่อไม่มีบทความ) */
  async saveCategories(staff: Staff, input: z.infer<typeof CategoriesBody>) {
    await this.db.transaction(async (tx) => {
      const current = await tx.select().from(s.helpCategories).orderBy(asc(s.helpCategories.position));
      const keep = new Set(input.items.map((i) => i.id).filter(Boolean));
      for (const c of current.filter((c) => !keep.has(c.id))) {
        const [n] = rowsOf<{ n: number }>(await tx.execute(sql`select count(*)::int as n from help_articles where category_id = ${c.id}`));
        if (n?.n) throw new AppError(409, 'category_has_articles', `หมวด "${c.name}" ยังมีบทความ ${n.n} บทความ · ย้ายบทความออกก่อนลบ`);
        await tx.delete(s.helpCategories).where(eq(s.helpCategories.id, c.id));
      }
      const changes: string[] = [];
      for (const [i, item] of input.items.entries()) {
        if (item.id) {
          const c = current.find((x) => x.id === item.id);
          if (!c) throw new AppError(404, 'not_found', 'ไม่พบหมวด');
          if (c.name !== item.name) changes.push(`${c.name} → ${item.name}`);
          await tx.update(s.helpCategories).set({ name: item.name, nameEn: item.nameEn ?? c.nameEn, position: i + 1 }).where(eq(s.helpCategories.id, c.id));
        } else {
          let slug = item.slug ?? item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
          if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug) || current.some((c) => c.slug === slug)) slug = `category-${randomBytes(3).toString('hex')}`;
          await tx.insert(s.helpCategories).values({ slug, name: item.name, nameEn: item.nameEn ?? null, position: i + 1 });
          changes.push(`เพิ่ม ${item.name}`);
        }
      }
      const removed = current.filter((c) => !keep.has(c.id)).map((c) => `ลบ ${c.name}`);
      await staffAudit(tx, staff, 'help.categories_updated', ['จัดหมวดศูนย์ช่วยเหลือ', ...changes, ...removed].join(' · '));
    });
    return this.categories();
  }

  // ── สร้างบทความจาก Ticket (X8) ─────────────────────────

  private async ticket(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบ Ticket');
    const [t] = await this.db.select().from(s.supportTickets).where(eq(s.supportTickets.id, id));
    if (!t) throw new AppError(404, 'not_found', 'ไม่พบ Ticket');
    return t;
  }

  /** เติมหัวข้อจากสาเหตุ และเนื้อหาจากผลลัพธ์ตอนปิด + คำตอบสุดท้ายของทีม · เป็นแค่ร่าง ต้องลบข้อมูลส่วนบุคคลเอง */
  async fromTicket(id: string) {
    const t = await this.ticket(id);
    const [solved] = await this.rows<{ body: string }>(sql`
      select body from support_ticket_messages where ticket_id = ${t.id} and internal and body like 'ปิดเรื่อง · %' order by created_at desc limit 1`);
    const [reply] = await this.rows<{ body: string }>(sql`
      select body from support_ticket_messages where ticket_id = ${t.id} and author_kind = 'staff' and not internal order by created_at desc limit 1`);
    const outcome = solved?.body.replace(/^ปิดเรื่อง · /, '').replace(/ · สาเหตุ: .*$/s, '') ?? '';
    const slug = TICKET_TO_CATEGORY[t.category ?? ''];
    const [cat] = slug ? await this.db.select({ id: s.helpCategories.id }).from(s.helpCategories).where(eq(s.helpCategories.slug, slug)) : [];
    return {
      ticket: { id: t.id, number: t.number, subject: t.subject, cause: t.cause, status: t.status },
      draft: { title: t.cause ?? t.subject, body: [outcome, reply?.body].filter(Boolean).join('\n\n'), categoryId: cat?.id ?? null },
    };
  }

  async createFromTicket(staff: Staff, id: string, input: z.infer<typeof FromTicketBody>) {
    const t = await this.ticket(id);
    const { article } = await this.create(staff, { title: input.title, categoryId: input.categoryId, body: input.body }, { sourceTicketId: t.id });
    if (input.link) await this.db.insert(s.helpArticleTickets).values({ articleId: article.id, ticketId: t.id, source: 'created_from', createdBy: staff.id }).onConflictDoNothing();
    await staffAudit(this.db, staff, 'help.article_from_ticket', `สร้างร่างบทความ "${input.title}" จาก Ticket #${t.number}`, { type: 'help_article', id: article.id }, t.workspaceId ?? undefined);
    return { article };
  }
}
