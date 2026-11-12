// W26 · ชนิดข้อมูลและตัวช่วยของศูนย์ช่วยเหลือ (ใช้ API ของ A44: help/* และ w/{ws}/support/*)
import { api } from "@/lib/api";

export interface HelpCategory {
  id: string;
  slug: string;
  name: string;
  articles: number;
}
export interface HelpArticleSummary {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  category: { slug: string; name: string } | null;
  visibility: "public" | "signed_in";
  appRoutes: string[];
  readMinutes: number;
  updatedAt: string;
  publishedAt: string | null;
  snippet?: string | null;
}
export interface HelpArticle extends HelpArticleSummary {
  body: string;
  hasEnglish: boolean;
}
export interface ArticleList {
  items: HelpArticleSummary[];
  total: number;
  terms?: string[];
  partial?: boolean;
  fallback?: boolean;
}
export interface ArticleDetail {
  article: HelpArticle;
  related: HelpArticleSummary[];
}

export interface Duration {
  n: number;
  unit: "h" | "d";
}
export type TicketStatus = "open" | "pending_customer" | "pending_dev" | "solved" | "closed";
export interface SupportTicket {
  id: string;
  number: number;
  subject: string;
  category: string | null;
  status: TicketStatus;
  mine: boolean;
  requester: { id: string; name: string | null } | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  firstResponseDueAt: string | null;
  firstRespondedAt: string | null;
  solvedAt: string | null;
  closedAt: string | null;
  dev: { sentAt: string | null; fixed: boolean } | null;
  canReply: boolean;
  canClose: boolean;
  canReopen: boolean;
}
export interface TicketList {
  items: SupportTicket[];
  openMine: number;
  canContact: boolean;
  canViewWorkspace: boolean;
  plan: { code: string; name: string | null };
  sla: { first: Duration | null; resolve: Duration | null };
}
export interface TicketMessage {
  id: string;
  author: "me" | "customer" | "staff" | "system";
  authorName: string | null;
  body: string;
  createdAt: string;
  files: { name: string; size: number; mime: string; url: string }[];
  context: { page: string | null; requestId: string | null; impact: string | null } | null;
  article: { slug: string; title: string } | null;
}
export interface TicketDetail {
  ticket: SupportTicket;
  messages: TicketMessage[];
}
export interface UploadTarget {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  uploadToken: string;
  maxBytes: number;
}

/** หมวด Ticket ของ O22 (TICKET_CATEGORIES) ตามลำดับในฟอร์ม X5 */
export const TICKET_CATEGORIES = ["how_to", "bug", "notification", "import", "api", "feature_request", "billing", "payment", "tax_invoice", "outage", "account", "other"] as const;
export const IMPACTS = ["me", "team", "blocked"] as const;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 5;
/** ค่าเริ่มต้นของ O22 · API ยังไม่ส่งค่าที่ตั้งจริงมาในรายการ Ticket */
export const REOPEN_DAYS = 7;

const ws = (slug: string) => `/w/${encodeURIComponent(slug)}`;

export const helpKeys = {
  categories: ["help", "categories"] as const,
  list: (params: string) => ["help", "articles", params] as const,
  article: (slug: string) => ["help", "article", slug] as const,
  tickets: (slug: string, scope: string) => ["help", "tickets", slug, scope] as const,
  ticket: (slug: string, id: string) => ["help", "ticket", slug, id] as const,
};

export const helpApi = {
  categories: () => api.get<{ items: HelpCategory[] }>("/help/categories"),
  articles: (params: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
    return api.get<ArticleList>(`/help/articles?${q}`);
  },
  article: (slug: string) => api.get<ArticleDetail>(`/help/articles/${encodeURIComponent(slug)}`),
  feedback: (slug: string, body: { helpful: boolean; comment?: string }) => api.post<{ ok: true }>(`/help/articles/${encodeURIComponent(slug)}:feedback`, body),
  tickets: (slug: string, scope: "mine" | "workspace" = "mine") => api.get<TicketList>(`${ws(slug)}/support/tickets?scope=${scope}`),
  ticket: (slug: string, id: string) => api.get<TicketDetail>(`${ws(slug)}/support/tickets/${encodeURIComponent(id)}`),
  create: (slug: string, body: unknown) => api.post<{ ticket: SupportTicket; sla: { first: Duration | null; open: boolean }; emailed: boolean }>(`${ws(slug)}/support/tickets`, body),
  reply: (slug: string, id: string, body: unknown) => api.post<{ status: TicketStatus; reopened: boolean }>(`${ws(slug)}/support/tickets/${encodeURIComponent(id)}/messages`, body),
  close: (slug: string, id: string) => api.post<{ status: TicketStatus }>(`${ws(slug)}/support/tickets/${encodeURIComponent(id)}:close`),
  reopen: (slug: string, id: string) => api.post<{ status: TicketStatus }>(`${ws(slug)}/support/tickets/${encodeURIComponent(id)}:reopen`),
  upload: (slug: string, file: File) => api.post<UploadTarget>(`${ws(slug)}/support/attachments`, { name: file.name, size: file.size, mime: file.type || "application/octet-stream" }),
  supportAccess: (slug: string) => api.put(`${ws(slug)}/support-access`, { enabled: true, duration: "7d", maxMode: "read" }),
};

/**
 * หน้าในแอปจาก pathname เพื่อแนะนำบทความ (X4) · ตรงกับ `app_routes` ที่ทีมผูกในตัวแก้บทความ (19b)
 * เช่น /work/a/p/DE/gantt → gantt · /work/a/p/DE/board → kanban · /work/a/admin/trash → admin.trash
 */
export function routeOf(pathname: string): string {
  const rest = pathname.replace(/^\/work\/[^/]+/, "").replace(/\/+$/, "");
  const project = /^\/p\/[^/]+(?:\/([^/]+))?(?:\/([^/]+))?/.exec(rest);
  if (project) {
    const tab = project[1] ?? "overview";
    if (tab === "board") return "kanban";
    if (tab === "settings") return project[2] ? `settings.${project[2]}`.slice(0, 41) : "settings";
    return tab;
  }
  if (!rest) return "home";
  const [first, second] = rest.slice(1).split("/");
  if (first === "admin" && second) return `admin.${second}`.slice(0, 41);
  return first;
}
/** ชื่อหน้า (routes.*) จากรหัสหน้า · admin.trash → admin */
export const routeLabelKey = (route: string) => {
  const base = route.split(".")[0];
  const known = ["home", "my-tasks", "inbox", "overview", "table", "kanban", "timeline", "gantt", "calendar", "backlog", "files", "dashboard", "reports", "automation", "settings", "members", "import", "admin", "profile", "billing", "search", "help"];
  return known.includes(base) ? base : "other";
};
const ROUTE_RE = /^[a-z0-9][a-z0-9.-]{0,40}$/;
export const isRoute = (route: string) => ROUTE_RE.test(route);

/** ลิงก์อัปโหลดของที่เก็บในเครื่องชี้ origin ของ API ตรง ๆ (ไม่เปิด CORS) จึงส่งผ่าน proxy /api/v1 ของเว็บ */
export function proxiedUploadUrl(url: string) {
  try {
    const u = new URL(url, "http://local");
    if (u.pathname.startsWith("/api/v1/storage/")) return `${u.pathname}${u.search}`;
  } catch {
    // URL แปลก ๆ ใช้ตามเดิม
  }
  return url;
}

/** อัปโหลดไฟล์แนบ: ขอลิงก์ → PUT → ได้ uploadToken ไว้ส่งกับ Ticket / ข้อความ */
export async function uploadAttachment(slug: string, file: File) {
  const target = await helpApi.upload(slug, file);
  const response = await fetch(proxiedUploadUrl(target.url), { method: target.method, headers: target.headers, body: file });
  if (!response.ok) throw new Error(`upload_failed_${response.status}`);
  return { uploadToken: target.uploadToken };
}
