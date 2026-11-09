import type { OpsRole } from "@/lib/types";

/**
 * เมนูซ้ายตาม Canvas Sidebar · ซ่อนรายการที่บทบาทไม่มีสิทธิ์ (06-ops-roles › 2) · ops-api ตรวจซ้ำเสมอ
 * `href` = หน้าที่เปิดใช้แล้ว · ไม่มี = เฟส 2–3 ("เร็ว ๆ นี้") · `built: false` = หน้าเฟส 1 ที่ยังทำไม่เสร็จ (O11–O15 เปิดเอง)
 * `badge` = ชื่อตัวเลขจาก ops/overview › tasks
 */
export type NavKey =
  | "home" | "customers" | "users" | "success" | "renewals" | "leads" | "quotes"
  | "billing" | "verify" | "refunds" | "accounting" | "promotions" | "entitlements" | "announce" | "changelog" | "onboarding"
  | "business" | "funnel" | "adoption" | "support" | "sessions" | "supportSettings" | "help" | "bugs"
  | "system" | "ops" | "deliveries" | "flags" | "ratelimit" | "scripts"
  | "privacy" | "abuse" | "legal" | "restore" | "jit" | "staff" | "audit" | "roadmap";
export type GroupKey = "" | "customers" | "sales" | "money" | "marketing" | "analytics" | "support" | "system" | "security" | "team";
export type TaskKey = "paymentExceptions" | "slipsToReview" | "approvals" | "ticketsBreached" | "ticketsUnassigned" | "incidentsOpen" | "invoicesOverdue" | "trialEndingSoon" | "privacyDueSoon" | "breachesOpen";

export interface NavItem {
  key: NavKey;
  href?: string;
  built?: boolean;
  roles: OpsRole[];
  badge?: TaskKey[];
}

const ALL: OpsRole[] = [];
const MONEY: OpsRole[] = ["owner", "finance", "auditor"];

export const NAV: { group: GroupKey; items: NavItem[] }[] = [
  { group: "", items: [{ key: "home", href: "/", built: true, roles: ALL }] },
  {
    group: "customers",
    items: [
      { key: "customers", href: "/workspaces", built: true, roles: ALL },
      { key: "users", href: "/users", built: false, roles: ["owner", "support"] },
      { key: "success", roles: ["owner", "support"] },
      { key: "renewals", roles: ["owner", "finance"] },
    ],
  },
  { group: "sales", items: [{ key: "leads", roles: ["owner"] }, { key: "quotes", roles: ["owner", "finance"] }] },
  {
    group: "money",
    items: [
      { key: "billing", href: "/payments", built: true, roles: MONEY },
      { key: "verify", href: "/payments", built: true, roles: MONEY, badge: ["paymentExceptions"] },
      { key: "refunds", href: "/refunds", built: false, roles: MONEY, badge: ["approvals"] },
      { key: "accounting", href: "/billing?tab=revenue", built: false, roles: MONEY },
    ],
  },
  {
    group: "marketing",
    items: [
      { key: "promotions", roles: ["owner", "finance"] },
      { key: "entitlements", roles: ["owner", "finance", "engineer"] },
      { key: "announce", roles: ["owner"] },
      { key: "changelog", roles: ["owner"] },
      { key: "onboarding", roles: ["owner", "support"] },
    ],
  },
  {
    group: "analytics",
    items: [
      { key: "business", href: "/business", built: false, roles: MONEY },
      { key: "funnel", href: "/business?tab=funnel", built: false, roles: MONEY },
      { key: "adoption", href: "/business?tab=adoption", built: false, roles: MONEY },
    ],
  },
  {
    group: "support",
    items: [
      { key: "support", href: "/support", built: true, roles: ["owner", "support"], badge: ["ticketsUnassigned"] },
      { key: "sessions", href: "/support", built: true, roles: ["owner", "support"] },
      { key: "supportSettings", roles: ["owner", "support"] },
      { key: "help", roles: ["owner", "support"] },
      { key: "bugs", roles: ["owner", "support", "engineer"] },
    ],
  },
  {
    group: "system",
    items: [
      { key: "system", href: "/system", built: false, roles: ["owner", "engineer"] },
      { key: "ops", href: "/operations", built: false, roles: ["owner", "engineer", "support"], badge: ["incidentsOpen"] },
      { key: "deliveries", roles: ["owner", "engineer", "support"] },
      { key: "flags", href: "/flags", built: true, roles: ["owner", "engineer"] },
      { key: "ratelimit", roles: ["owner", "engineer"] },
      { key: "scripts", roles: ["owner", "engineer"] },
    ],
  },
  {
    group: "security",
    items: [
      { key: "privacy", href: "/privacy", built: false, roles: ["owner", "support", "auditor"], badge: ["privacyDueSoon"] },
      { key: "abuse", roles: ["owner", "engineer"] },
      { key: "legal", href: "/legal", built: false, roles: ["owner", "auditor"] },
      { key: "restore", roles: ["owner"] },
      { key: "jit", roles: ["owner"] },
    ],
  },
  {
    group: "team",
    items: [
      { key: "staff", href: "/staff", built: true, roles: ["owner", "auditor"] },
      { key: "audit", href: "/staff?tab=audit", built: true, roles: ["owner", "auditor"] },
      { key: "roadmap", href: "/soon", built: true, roles: ALL },
    ],
  },
];

/** ลิงก์จริงของรายการ · ยังไม่มีหน้า → หน้าแผนฟีเจอร์ */
export const linkOf = (item: NavItem) => (item.href && item.built ? item.href : `/soon?f=${item.key}`);
export const isSoon = (item: NavItem) => !item.href || !item.built;

/** หาเมนูของหน้าปัจจุบัน (ใช้ทำ breadcrumb และ aria-current) */
export function currentItem(pathname: string, search: string) {
  const all = NAV.flatMap((g) => g.items.map((i) => ({ ...i, group: g.group }))).filter((i) => i.href && i.built);
  const exact = all.find((i) => i.href === `${pathname}${search ? `?${search}` : ""}`);
  if (exact) return exact;
  return all.filter((i) => !i.href!.includes("?") && (i.href === "/" ? pathname === "/" : pathname === i.href || pathname.startsWith(`${i.href}/`))).pop() ?? null;
}
