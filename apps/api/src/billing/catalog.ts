// แค็ตตาล็อกแพ็กเกจ: ขีดจำกัด, ราคา และสูตรใบเสนอราคา · เงินเป็นสตางค์ทั้งหมด
import { PLAN_DEFAULT_MONTHLY_SATANG, YEARLY_MONTHS as DEFAULT_YEARLY_MONTHS } from '@friday/db';

export type PlanCode = 'free' | 'team_s' | 'team_m' | 'team_l' | 'enterprise';
export type Cycle = 'monthly' | 'yearly';

export interface PlanSpec {
  code: PlanCode;
  name: string;
  /** null = ไม่จำกัด */
  seats: number | null;
  projects: number | null;
  /** GB ต่อสมาชิก (ไม่นับ Guest) · null = ไม่จำกัด */
  storageGbPerMember: number | null;
  /** ราคารายเดือนต่อ Workspace (สตางค์) · null = ติดต่อฝ่ายขาย / ฟรี */
  monthlySatang: number | null;
}

// ราคาตั้งต้นอยู่ใน @friday/db ให้หลังบ้าน (O20) แสดงราคาเดียวกัน
const price = (code: string) => PLAN_DEFAULT_MONTHLY_SATANG[code] ?? null;

/**
 * ขีดจำกัดตาม docs/decisions.md (Free ≤ 5, S ≤ 10, M ≤ 25, L ≤ 50) และหน้า Q2 / Landing
 * (Free 3 โปรเจกต์ ไฟล์ 1 GB · Team ไม่จำกัดโปรเจกต์ ไฟล์ 10 GB ต่อคน)
 * ราคายังไม่ตกลงจริง: ใช้ตัวเลขในหน้า Checkout เป็นค่าตั้งต้น และให้ค่าใน `plans.price_*` ชนะเมื่อมี
 */
export const PLAN_CATALOG: Record<PlanCode, PlanSpec> = {
  free: { code: 'free', name: 'Free', seats: 5, projects: 3, storageGbPerMember: 1, monthlySatang: 0 },
  team_s: { code: 'team_s', name: 'Team S', seats: 10, projects: null, storageGbPerMember: 10, monthlySatang: price('team_s') },
  team_m: { code: 'team_m', name: 'Team M', seats: 25, projects: null, storageGbPerMember: 10, monthlySatang: price('team_m') },
  team_l: { code: 'team_l', name: 'Team L', seats: 50, projects: null, storageGbPerMember: 10, monthlySatang: price('team_l') },
  enterprise: { code: 'enterprise', name: 'Enterprise', seats: null, projects: null, storageGbPerMember: null, monthlySatang: null },
};

export const PLAN_ORDER: PlanCode[] = ['free', 'team_s', 'team_m', 'team_l', 'enterprise'];
export const TRIAL_PLAN: PlanCode = 'team_s';
export const TRIAL_DAYS = 14;
export const GB = 1024 ** 3;
export const VAT_RATE = 0.07;
export const WHT_RATE = 0.03;
/** รายปีจ่าย 10 เดือน ใช้ 12 เดือน (หน้า Checkout) */
export const YEARLY_MONTHS = DEFAULT_YEARLY_MONTHS;

export interface Quote {
  plan: PlanCode;
  planName: string;
  cycle: Cycle;
  wht: boolean;
  subtotal: number;
  vat: number;
  total: number;
  whtAmount: number;
  amountDue: number;
}

/** ราคาตามรอบ · แพ็กเกจที่ไม่มีราคา (Free, Enterprise) คำนวณใบเสนอราคาไม่ได้ → null */
export function priceFor(spec: PlanSpec, cycle: Cycle, override?: { monthly: number | null; yearly: number | null }): number | null {
  if (cycle === 'yearly') {
    if (override?.yearly != null) return override.yearly;
    // ไม่ได้ตั้งราคาปีเอง → คิดจากราคาเดือนที่ใช้จริง (override ก่อน catalog) × YEARLY_MONTHS (BUG-12)
    // ราคาเดือน 0 ที่ตั้งใจ (override = 0) ได้ราคาปี 0 · ไม่มีราคาเลย (Free / Enterprise) = null
    if (override?.monthly != null) return override.monthly * YEARLY_MONTHS;
    return spec.monthlySatang ? spec.monthlySatang * YEARLY_MONTHS : null;
  }
  if (override?.monthly != null) return override.monthly;
  return spec.monthlySatang || null;
}

/** VAT 7% คิดจากยอดก่อนภาษี (เฉพาะเมื่อบริษัทจด VAT) · หัก ณ ที่จ่าย 3% คิดจากยอดก่อน VAT · ใบกำกับภาษียังออกเต็มจำนวน */
export function computeQuote(spec: PlanSpec, cycle: Cycle, wht: boolean, subtotal: number, vatRegistered = true): Quote {
  const vat = vatRegistered ? Math.round(subtotal * VAT_RATE) : 0;
  const total = subtotal + vat;
  const whtAmount = wht ? Math.round(subtotal * WHT_RATE) : 0;
  return { plan: spec.code, planName: spec.name, cycle, wht, subtotal, vat, total, whtAmount, amountDue: total - whtAmount };
}

export interface SubscriptionLike {
  planCode: PlanCode;
  status: 'trialing' | 'active' | 'past_due' | 'canceled';
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
}

/** แพ็กเกจที่ใช้สิทธิ์จริง ณ เวลานี้: ทดลองหมด / ยกเลิกแล้วครบรอบ → Free */
export function effectivePlan(sub: SubscriptionLike, now = new Date()): PlanCode {
  if (sub.status === 'trialing') return sub.trialEndsAt && now < sub.trialEndsAt ? sub.planCode : 'free';
  if (sub.status === 'canceled') return sub.currentPeriodEnd && now < sub.currentPeriodEnd ? sub.planCode : 'free';
  return sub.planCode;
}

/** แพ็กเกจเล็กที่สุดที่รองรับจำนวนสมาชิกนี้ (ไม่มี → Enterprise) */
export function smallestPlanForSeats(seats: number): PlanCode {
  return PLAN_ORDER.find((c) => c !== 'free' && (PLAN_CATALOG[c].seats === null || PLAN_CATALOG[c].seats! >= seats)) ?? 'enterprise';
}
