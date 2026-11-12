import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema, type Tx, withTenant } from '@friday/db';
import { and, asc, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../common/errors.js';
import type { AuthInfo } from '../common/request.js';
import { APP_DB } from '../db/db.module.js';

const s = schema;
const a = s.helpArticles;

const Bool = z.preprocess((v) => (v === '1' ? 'true' : v === '0' ? 'false' : v), z.stringbool());
export const ArticlesQuery = z.object({
  /** slug ของหมวด */
  category: z.string().trim().min(1).max(64).optional(),
  /** คำค้น ภาษาไทยหรืออังกฤษ · คั่นคำด้วยช่องว่าง */
  q: z.string().trim().min(1).max(200).optional(),
  /** หน้าในแอปที่เปิดอยู่ เช่น gantt · kanban · import (แผง X4) · ไม่มีบทความผูก = บทความยอดนิยมแทน */
  route: z.string().trim().regex(/^[a-z0-9][a-z0-9.-]{0,40}$/, 'รูปแบบหน้าไม่ถูกต้อง').optional(),
  sort: z.enum(['popular', 'recent', 'title']).default('popular'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** คำแนะนำระหว่างพิมพ์ (ฟอร์ม X5) ไม่นับเป็นการค้นหาในสถิติ */
  suggest: Bool.default(false),
  locale: z.enum(['th', 'en']).default('th'),
});
export const ArticleQuery = z.object({ locale: z.enum(['th', 'en']).default('th'), track: Bool.default(true) });
export const FeedbackBody = z
  .object({
    helpful: z.boolean(),
    /** "ยังขาดอะไร" หลังกดไม่ช่วย */
    comment: z.string().trim().max(2000).optional(),
  })
  .strict();

/** คอลัมน์ที่ friday_app อ่านได้ (grant รายคอลัมน์ใน 0033) · ห้าม select ทั้งแถว เพราะร่างและข้อมูลภายในไม่ได้ grant */
const cols = {
  id: a.id,
  slug: a.slug,
  categoryId: a.categoryId,
  title: a.title,
  summary: a.summary,
  body: a.body,
  titleEn: a.titleEn,
  summaryEn: a.summaryEn,
  bodyEn: a.bodyEn,
  visibility: a.visibility,
  appRoutes: a.appRoutes,
  publishedAt: a.publishedAt,
  updatedAt: a.updatedAt,
  searchText: a.searchText,
};
type Row = Pick<typeof a.$inferSelect, keyof typeof cols>;
type Cat = { id: string; slug: string; name: string; nameEn: string | null };

const SNIPPET = 60;
/** ตัด wildcard ของ LIKE ในคำค้น */
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
/** ตัดสัญลักษณ์ Markdown ออกก่อนทำข้อความตัวอย่าง */
export const plain = (md: string) =>
  md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^:::\s*\w*\s*$/gm, ' ')
    .replace(/[#>*_`|~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
/** แยกคำค้น: ตัวพิมพ์เล็ก ไม่ซ้ำ ไม่เกิน 8 คำ */
export const termsOf = (q: string) => [...new Set(q.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
/** อ่านจบใน N นาที (ไทยราว 700 ตัวอักษรต่อนาที) */
const readMinutes = (body: string) => Math.max(1, Math.round(plain(body).length / 700));

function snippetOf(text: string, terms: string[]): string | null {
  const lower = text.toLowerCase();
  const at = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((x, y) => x - y)[0];
  // คำที่ตรงอยู่ในหัวข้อหรือคำค้นเพิ่ม ไม่อยู่ในเนื้อหา: ใช้ต้นเนื้อหาแทน
  if (at === undefined) return text ? `${text.slice(0, SNIPPET * 2)}${text.length > SNIPPET * 2 ? '…' : ''}` : null;
  const from = Math.max(0, at - SNIPPET);
  const to = Math.min(text.length, at + SNIPPET * 2);
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
}

/**
 * A44 · บทความศูนย์ช่วยเหลือ (X1–X4 และหน้าสาธารณะ /help) · ไม่ต้องเข้าสู่ระบบ
 * อ่านด้วย friday_app ภายใต้ RLS: เห็นเฉพาะที่เผยแพร่ · "เฉพาะผู้เข้าสู่ระบบ" ต้องมี app.user_id (ผู้ใช้ที่ล็อกอินอยู่)
 * ค้นด้วย ILIKE ทีละคำบน search_text (GIN pg_trgm) แบบเดียวกับค้นหางาน (A22) เพราะ tsvector ตัดคำภาษาไทยไม่ได้
 */
@Injectable()
export class HelpArticlesService {
  constructor(@Inject(APP_DB) private readonly db: Db) {}

  /** ธุรกรรมของผู้อ่าน · ไม่ได้ล็อกอิน = app.user_id ว่าง จึงเห็นเฉพาะบทความ "ทุกคน" */
  private read<T>(auth: AuthInfo | undefined, fn: (tx: Tx) => Promise<T>) {
    return withTenant(this.db, { userId: auth?.userId ?? '', workspaceId: null }, fn);
  }

  private async categories(tx: Tx) {
    return tx.select({ id: s.helpCategories.id, slug: s.helpCategories.slug, name: s.helpCategories.name, nameEn: s.helpCategories.nameEn }).from(s.helpCategories).orderBy(asc(s.helpCategories.position), asc(s.helpCategories.name));
  }

  /** ยอดอ่าน 30 วันของบทความ (เรียงยอดนิยม) */
  private async views(tx: Tx, ids: string[]) {
    if (!ids.length) return new Map<string, number>();
    const rows = await tx
      .select({ id: s.helpArticleViews.articleId, n: sql<number>`sum(${s.helpArticleViews.views})::int` })
      .from(s.helpArticleViews)
      .where(and(inArray(s.helpArticleViews.articleId, ids), sql`${s.helpArticleViews.day} > (now() at time zone 'Asia/Bangkok')::date - 30`))
      .groupBy(s.helpArticleViews.articleId);
    return new Map(rows.map((r) => [r.id, r.n]));
  }

  private dto(r: Row, cats: Map<string, Cat>, locale: 'th' | 'en', extra: Record<string, unknown> = {}) {
    const en = locale === 'en' && !!r.titleEn;
    const c = cats.get(r.categoryId);
    return {
      id: r.id,
      slug: r.slug,
      title: en ? r.titleEn! : r.title,
      summary: (en ? r.summaryEn : r.summary) ?? null,
      category: c ? { slug: c.slug, name: locale === 'en' && c.nameEn ? c.nameEn : c.name } : null,
      visibility: r.visibility,
      appRoutes: r.appRoutes,
      readMinutes: readMinutes(en ? (r.bodyEn ?? r.body) : r.body),
      updatedAt: r.updatedAt,
      publishedAt: r.publishedAt,
      ...extra,
    };
  }

  /** หมวดพร้อมจำนวนบทความที่ผู้อ่านเห็น (X1) */
  async listCategories(auth: AuthInfo | undefined, locale: 'th' | 'en' = 'th') {
    return this.read(auth, async (tx) => {
      const cats = await this.categories(tx);
      const counts = await tx.select({ id: a.categoryId, n: sql<number>`count(*)::int` }).from(a).groupBy(a.categoryId);
      const byId = new Map(counts.map((c) => [c.id, c.n]));
      return { items: cats.map((c) => ({ id: c.id, slug: c.slug, name: locale === 'en' && c.nameEn ? c.nameEn : c.name, articles: byId.get(c.id) ?? 0 })) };
    });
  }

  /**
   * รายการ / ค้นหา / แนะนำตามหน้า
   * - q: ทุกคำต้องอยู่ในบทความ · ไม่มีบทความที่ตรงครบ = ตรงอย่างน้อยครึ่งหนึ่งของคำ (`partial`) · บันทึกสถิติค้นหาผ่าน app.record_help_search
   * - route: บทความที่ผูกหน้านั้น · ไม่มี = ยอดนิยม (`fallback`)
   */
  async list(auth: AuthInfo | undefined, q: z.infer<typeof ArticlesQuery>) {
    return this.read(auth, async (tx) => {
      const cats = new Map((await this.categories(tx)).map((c) => [c.id, c]));
      const conds: SQL[] = [];
      let category: Cat | null = null;
      if (q.category) {
        category = [...cats.values()].find((c) => c.slug === q.category) ?? null;
        if (!category) throw new AppError(404, 'help_category_not_found', 'ไม่พบหมวดนี้');
        conds.push(eq(a.categoryId, category.id));
      }
      const order = q.sort === 'title' ? [asc(a.title)] : q.sort === 'recent' ? [desc(a.publishedAt)] : [desc(a.publishedAt)];

      if (q.q) {
        const terms = termsOf(q.q);
        const hit = (t: string) => sql`${a.searchText} ilike ${like(t)}`;
        const rows = await tx
          .select({ ...cols, matched: sql<number>`(${sql.join(terms.map((t) => sql`(${hit(t)})::int`), sql` + `)})` })
          .from(a)
          .where(and(...conds, sql`(${sql.join(terms.map(hit), sql` or `)})`))
          .limit(200);
        const full = rows.filter((r) => r.matched === terms.length);
        const partial = !full.length;
        const need = Math.max(1, Math.ceil(terms.length / 2));
        const found = (partial ? rows.filter((r) => r.matched >= need) : full).map((r) => {
          const title = r.title.toLowerCase();
          const inTitle = terms.filter((t) => title.includes(t)).length;
          return { r, score: r.matched * 10 + inTitle * 5 + (title.includes(q.q!.toLowerCase()) ? 20 : 0) };
        });
        const views = await this.views(tx, found.map((f) => f.r.id));
        found.sort((x, y) => y.score - x.score || (views.get(y.r.id) ?? 0) - (views.get(x.r.id) ?? 0));
        if (!q.suggest) await tx.execute(sql`select app.record_help_search(${q.q}, ${found.length > 0})`);
        return {
          items: found.slice(0, q.limit).map(({ r }) => this.dto(r, cats, q.locale, { snippet: snippetOf(plain(r.summary ? `${r.summary} ${r.body}` : r.body), terms) })),
          total: found.length,
          terms,
          partial: partial && found.length > 0,
        };
      }

      if (q.route) {
        const bound = await tx
          .select(cols)
          .from(a)
          .where(and(...conds, sql`${a.appRoutes} @> array[${q.route}]::text[]`))
          .orderBy(...order)
          .limit(q.limit);
        if (bound.length) return { items: bound.map((r) => this.dto(r, cats, q.locale)), total: bound.length, fallback: false };
      }

      const rows = await tx.select(cols).from(a).where(and(...conds)).orderBy(...order).limit(q.sort === 'popular' ? 200 : q.limit);
      if (q.sort === 'popular') {
        const views = await this.views(tx, rows.map((r) => r.id));
        rows.sort((x, y) => (views.get(y.id) ?? 0) - (views.get(x.id) ?? 0));
      }
      return { items: rows.slice(0, q.limit).map((r) => this.dto(r, cats, q.locale)), total: rows.length, ...(q.route ? { fallback: true } : {}) };
    });
  }

  /** หน้าบทความ (X3) พร้อมบทความที่เกี่ยวข้องในหมวดเดียวกัน · นับยอดอ่านผ่าน app.record_help_view */
  async get(auth: AuthInfo | undefined, slug: string, q: z.infer<typeof ArticleQuery>) {
    return this.read(auth, async (tx) => {
      const [r] = await tx.select(cols).from(a).where(eq(a.slug, slug.toLowerCase()));
      // ไม่มี / ยังเป็นร่าง / เฉพาะผู้เข้าสู่ระบบแต่ยังไม่ล็อกอิน: ตอบเหมือนกันทั้งหมด ไม่บอกว่ามีบทความอยู่
      if (!r) throw new AppError(404, 'help_article_not_found', 'ไม่พบบทความนี้');
      const cats = new Map((await this.categories(tx)).map((c) => [c.id, c]));
      const en = q.locale === 'en' && !!r.titleEn;
      const others = await tx.select(cols).from(a).where(and(eq(a.categoryId, r.categoryId), ne(a.id, r.id))).limit(50);
      const views = await this.views(tx, others.map((o) => o.id));
      others.sort((x, y) => (views.get(y.id) ?? 0) - (views.get(x.id) ?? 0));
      if (q.track) await tx.execute(sql`select app.record_help_view(${r.id})`);
      return {
        article: this.dto(r, cats, q.locale, { body: en ? (r.bodyEn ?? r.body) : r.body, hasEnglish: !!r.titleEn }),
        related: others.slice(0, 3).map((o) => this.dto(o, cats, q.locale)),
      };
    });
  }

  /** โหวต "ช่วยได้ไหม" (X3) · ไม่เก็บผู้ใช้หรือ Workspace · RLS ให้เพิ่มได้เฉพาะบทความที่ผู้โหวตเห็น */
  async feedback(auth: AuthInfo | undefined, slug: string, input: z.infer<typeof FeedbackBody>) {
    return this.read(auth, async (tx) => {
      const [r] = await tx.select({ id: a.id }).from(a).where(eq(a.slug, slug.toLowerCase()));
      if (!r) throw new AppError(404, 'help_article_not_found', 'ไม่พบบทความนี้');
      await tx.insert(s.helpFeedback).values({ articleId: r.id, helpful: input.helpful, comment: input.helpful ? null : input.comment || null });
      return { ok: true };
    });
  }

  /** บทความที่ลูกค้าแนบตอนเปิด Ticket (ต้องเป็นบทความที่ผู้ใช้เห็น) */
  async find(auth: AuthInfo, slug: string) {
    return this.read(auth, async (tx) => {
      const [r] = await tx.select({ id: a.id, slug: a.slug, title: a.title }).from(a).where(eq(a.slug, slug.toLowerCase()));
      return r ?? null;
    });
  }
}
