import type { OpsRole } from "@/lib/types";

/**
 * เมนูซ้ายตาม Canvas Sidebar · ซ่อนรายการที่บทบาทไม่มีสิทธิ์ (06-ops-roles › 2) · ops-api ตรวจซ้ำเสมอ
 * `href` = หน้าที่เปิดใช้แล้ว · ไม่มี = เฟส 2–3 ("เร็ว ๆ นี้") · `built: false` = หน้าเฟส 1 ที่ยังทำไม่เสร็จ (O11–O15 เปิดเอง)
 * `badge` = ชื่อตัวเลขจาก ops/overview › tasks
 */
export type NavKey =
  | "home" | "customers" | "accounts" | "users" | "success" | "renewals" | "leads" | "quotes"
  | "billing" | "verify" | "refunds" | "accounting" | "promotions" | "entitlements" | "announce" | "changelog" | "onboarding"
  | "business" | "funnel" | "adoption" | "support" | "sessions" | "supportSettings" | "help" | "bugs"
  | "system" | "ops" | "deliveries" | "flags" | "ratelimit" | "scripts"
  | "privacy" | "abuse" | "legal" | "restore" | "jit" | "staff" | "audit" | "roadmap";
export type GroupKey = "" | "customers" | "sales" | "money" | "marketing" | "analytics" | "support" | "system" | "security" | "team";
export type TaskKey = "paymentExceptions" | "slipsToReview" | "approvals" | "ticketsBreached" | "ticketsUnassigned" | "incidentsOpen" | "invoicesOverdue" | "trialEndingSoon" | "privacyDueSoon" | "breachesOpen" | "abuseOpen" | "rateLimitStreak" | "jitPending" | "playbookDue";

export interface NavItem {
  key: NavKey;
  href?: string;
  built?: boolean;
  roles: OpsRole[];
  badge?: TaskKey[];
  /** ลิงก์อื่นที่นับเป็นเมนูนี้ (แท็บภายในหน้าเดียวกัน) · ใช้ทำ breadcrumb และ aria-current */
  also?: string[];
}

const ALL: OpsRole[] = [];
const MONEY: OpsRole[] = ["owner", "finance", "auditor"];

export const NAV: { group: GroupKey; items: NavItem[] }[] = [
  { group: "", items: [{ key: "home", href: "/", built: true, roles: ALL }] },
  {
    group: "customers",
    items: [
      { key: "customers", href: "/workspaces", built: true, roles: ALL },
      // ช่วง 3 · บัญชีลูกค้าระดับบริษัท: ทุกคนอ่านได้ · วันต่อสัญญาเปิดให้ทีมที่ดูแลลูกค้า (Support ไม่เห็นยอดเงิน)
      { key: "accounts", href: "/accounts", built: true, roles: ALL },
      { key: "users", href: "/users", built: true, roles: ["owner", "support"] },
      { key: "success", href: "/success", built: true, roles: ["owner", "support"], badge: ["playbookDue"] },
      { key: "renewals", href: "/renewals", built: true, roles: ["owner", "finance", "support", "auditor"] },
    ],
  },
  { group: "sales", items: [{ key: "leads", roles: ["owner"] }, { key: "quotes", roles: ["owner", "finance"] }] },
  {
    group: "money",
    items: [
      { key: "billing", href: "/payments?tab=invoices", also: ["/payments?tab=overdue", "/payments?tab=tax"], built: true, roles: MONEY },
      { key: "verify", href: "/payments", also: ["/payments?tab=verify", "/payments?tab=incoming"], built: true, roles: MONEY, badge: ["paymentExceptions"] },
      { key: "refunds", href: "/refunds", built: true, roles: MONEY, badge: ["approvals"] },
      { key: "accounting", href: "/payments?tab=revenue", built: true, roles: MONEY },
    ],
  },
  {
    group: "marketing",
    items: [
      { key: "promotions", href: "/promotions", built: true, roles: ["owner", "finance"] },
      { key: "entitlements", href: "/entitlements", built: true, roles: ["owner", "finance", "engineer"] },
      { key: "announce", href: "/announcements", built: true, roles: ["owner"] },
      { key: "changelog", href: "/changelog", built: true, roles: ALL },
      // O34: การเงินและผู้ตรวจอ่านอย่างเดียว · วิศวกรไม่เห็น
      { key: "onboarding", href: "/onboarding", built: true, roles: ["owner", "support", "finance", "auditor"] },
    ],
  },
  {
    group: "analytics",
    items: [
      { key: "business", href: "/business", built: true, roles: MONEY },
      { key: "funnel", href: "/business/funnel", built: true, roles: MONEY },
      { key: "adoption", href: "/business/adoption", built: true, roles: MONEY },
    ],
  },
  {
    group: "support",
    items: [
      { key: "support", href: "/support", built: true, roles: ["owner", "support"], badge: ["ticketsUnassigned"] },
      { key: "sessions", href: "/support/sessions", built: true, roles: ["owner", "support"] },
      { key: "supportSettings", href: "/support/settings", built: true, roles: ["owner", "support"] },
      // ทุกบทบาทเปิดดูได้ (อ่านอย่างเดียว) · เขียน / เผยแพร่เฉพาะ Owner และ Support (O35)
      { key: "help", href: "/help", built: true, roles: ALL },
      { key: "bugs", href: "/bugs", built: true, roles: ["owner", "support", "engineer"] },
    ],
  },
  {
    group: "system",
    items: [
      { key: "system", href: "/system", built: true, roles: ["owner", "engineer"] },
      { key: "ops", href: "/incidents", built: true, roles: ["owner", "engineer", "support"], badge: ["incidentsOpen"] },
      { key: "deliveries", href: "/deliveries", built: true, roles: ["owner", "engineer", "support"] },
      { key: "flags", href: "/flags", built: true, roles: ["owner", "engineer"] },
      { key: "ratelimit", href: "/ratelimit", built: true, roles: ["owner", "engineer"], badge: ["rateLimitStreak"] },
      { key: "scripts", roles: ["owner", "engineer"] },
    ],
  },
  {
    group: "security",
    items: [
      { key: "privacy", href: "/privacy", built: true, roles: ["owner", "support", "engineer", "auditor"], badge: ["privacyDueSoon"] },
      { key: "abuse", href: "/abuse", built: true, roles: ["owner", "engineer"], badge: ["abuseOpen"] },
      { key: "legal", href: "/legal", built: true, roles: ["owner", "auditor"] },
      { key: "restore", href: "/restore", built: true, roles: ["owner", "support", "engineer", "auditor"] },
      // O52: ทุกบทบาทขอสิทธิ์ได้ · ตัวเลขรออนุมัติแสดงเฉพาะ Owner (Sidebar)
      { key: "jit", href: "/jit", built: true, roles: ALL, badge: ["jitPending"] },
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
  const here = `${pathname}${search ? `?${search}` : ""}`;
  // เทียบเฉพาะ ?tab= (ลิงก์ค้นหาอาจมี &q=… ต่อท้าย)
  const tab = new URLSearchParams(search).get("tab");
  const key = tab ? `${pathname}?tab=${tab}` : here;
  const exact = all.find((i) => i.href === here || i.href === key || i.also?.includes(key));
  if (exact) return exact;
  return all.filter((i) => !i.href!.includes("?") && (i.href === "/" ? pathname === "/" : pathname === i.href || pathname.startsWith(`${i.href}/`))).pop() ?? null;
}
