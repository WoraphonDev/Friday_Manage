// ชนิดข้อมูลของ ops-api › ops/help (O35) · ตรงกับสัญญาใน apps/ops-api/src/help

export const HELP_KEY = ["ops", "help"] as const;

export type ArticleStatus = "draft" | "published" | "archived";
export type Visibility = "public" | "signed_in";

export interface Overview {
  kpi: {
    published: number;
    review: number;
    drafts: number;
    searches30: number;
    misses30: number;
    missPct: number | null;
    deflectionPct: number | null;
    helpfulPct: number | null;
    votes30: number;
  };
  tabs: { articles: number; misses: number; review: number };
  topMisses: Miss[];
  canEdit: boolean;
}

export interface Miss {
  query: string;
  searches: number;
  tickets: number;
  articleId: string | null;
  articleTitle?: string | null;
  lastDay?: string;
}

export interface ArticleRow {
  id: string;
  slug: string;
  title: string;
  category: { id: string; name: string };
  status: ArticleStatus;
  needsReview: boolean;
  reviewReason: "overdue" | "low_helpful" | null;
  reads30: number;
  helpfulPct: number | null;
  votes: number;
  tickets: number;
  updatedAt: string;
  owner: { id: string; name: string } | null;
  hasDraft: boolean;
}

export interface Article {
  id: string;
  slug: string;
  status: ArticleStatus;
  categoryId: string;
  title: string;
  summary: string | null;
  body: string;
  titleEn: string | null;
  summaryEn: string | null;
  bodyEn: string | null;
  visibility: Visibility;
  appRoutes: string[];
  keywords: string | null;
  reviewAt: string | null;
  ownerId: string | null;
  piiCheckedAt: string | null;
  version: number;
  publishedAt: string | null;
  draftSavedAt: string | null;
  hasDraft: boolean;
  updatedAt: string;
}

export interface ArticleDetail {
  article: Article;
  versions: { version: number; publishedAt: string; publishedBy: string | null }[];
  sourceTicket: { id: string; number: number } | null;
  canEdit: boolean;
}

export interface Category {
  id: string;
  slug: string;
  name: string;
  nameEn: string | null;
  position: number;
  articles: number;
}

/** หน้าในแอปลูกค้าที่ผูกบทความได้ (แนะนำในแผงช่วยเหลือ X4) · ค่าเดียวกับ `route` ที่เว็บลูกค้าส่งให้ A44 */
export const APP_ROUTES = ["home", "my-tasks", "inbox", "overview", "table", "kanban", "timeline", "gantt", "calendar", "backlog", "files", "import", "members", "profile", "admin", "admin.trash", "billing", "search"] as const;
