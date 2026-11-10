// สิทธิ์และขีดจำกัดตามแพ็กเกจแบบมีเวอร์ชัน + ปรับเฉพาะราย (O21) · ใช้ร่วมกันระหว่าง apps/api (บังคับ 402 / 429) และ apps/ops-api (แก้ไข)
// กติกา: เวอร์ชันที่ใช้ = เลขสูงสุดที่ effective_at ผ่านแล้ว · ลดสิทธิ์ลูกค้าเดิมใช้ค่าเดิมจนจบรอบบิล · override ชนะค่าของแพ็กเกจเสมอ
import { and, desc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import type { Db, Tx } from './client.ts';
import { entitlementOverrides, entitlementVersions } from './schema/ops.ts';

export const ENTITLEMENT_PLANS = ['free', 'team_s', 'team_m', 'team_l', 'enterprise'] as const;
export type EntitlementPlan = (typeof ENTITLEMENT_PLANS)[number];
export type EntitlementValue = number | boolean | null;
export type Matrix = Record<EntitlementPlan, Record<string, EntitlementValue>>;

export interface EntitlementKey {
  key: string;
  kind: 'limit' | 'feature';
  /** หน่วยที่แสดง · count = จำนวน */
  unit?: 'count' | 'gb_per_member' | 'per_month' | 'per_minute' | 'days';
  /** API ลูกค้าบังคับใช้แล้ว · false = เก็บไว้แสดงในหน้าราคาและสัญญา ยังไม่ตรวจในแอป */
  enforced: boolean;
}

/** ลำดับเดียวกับตารางใน Canvas › Entitlements */
export const ENTITLEMENT_KEYS: readonly EntitlementKey[] = [
  { key: 'seats', kind: 'limit', unit: 'count', enforced: true },
  { key: 'projects', kind: 'limit', unit: 'count', enforced: true },
  { key: 'storage_gb_per_member', kind: 'limit', unit: 'gb_per_member', enforced: true },
  { key: 'automation_runs', kind: 'limit', unit: 'per_month', enforced: true },
  { key: 'api_rpm', kind: 'limit', unit: 'per_minute', enforced: true },
  { key: 'history_days', kind: 'limit', unit: 'days', enforced: false },
  { key: 'gantt', kind: 'feature', enforced: false },
  { key: 'import_update', kind: 'feature', enforced: true },
  { key: 'channels', kind: 'feature', enforced: true },
  { key: 'automation', kind: 'feature', enforced: true },
  { key: 'api', kind: 'feature', enforced: true },
  { key: 'guests', kind: 'feature', enforced: true },
  { key: 'sso', kind: 'feature', enforced: false },
  { key: 'sla', kind: 'feature', enforced: false },
];
export const ENTITLEMENT_KEY_NAMES = ENTITLEMENT_KEYS.map((k) => k.key);
export const keyOf = (key: string) => ENTITLEMENT_KEYS.find((k) => k.key === key);

/**
 * ปรับเฉพาะรายได้เฉพาะรายการเหล่านี้ (Canvas › เพิ่มการปรับเฉพาะราย)
 * `storage_gb` = พื้นที่รวมของ Workspace (GB) แทนสูตร GB ต่อคน × จำนวนสมาชิก
 */
export const OVERRIDE_KEYS = ['seats', 'storage_gb', 'api_rpm', 'automation_runs', 'sso'] as const;
export type OverrideKey = (typeof OVERRIDE_KEYS)[number];

/**
 * เวอร์ชัน 1 (ตั้งใน migration 0023 ด้วยค่าเดียวกัน) · ที่นั่ง โปรเจกต์ พื้นที่ เท่ากับ billing/catalog.ts เดิม
 * ฟีเจอร์ของ Free ตามหน้าราคา (public.service: Free ไม่มี Gantt, Import, Automation, LINE / Webhook) · Guest ใช้ได้ทุกแพ็กเกจ (guestsFree)
 * ค่าอื่นจากตัวอย่างใน Canvas · null = ไม่จำกัด / ตามสัญญา
 */
export const DEFAULT_MATRIX: Matrix = {
  free: { seats: 5, projects: 3, storage_gb_per_member: 1, automation_runs: 100, api_rpm: 0, history_days: 30, gantt: false, import_update: false, channels: false, automation: false, api: false, guests: true, sso: false, sla: false },
  team_s: { seats: 10, projects: null, storage_gb_per_member: 10, automation_runs: 5000, api_rpm: 60, history_days: 365, gantt: true, import_update: true, channels: true, automation: true, api: true, guests: true, sso: false, sla: false },
  team_m: { seats: 25, projects: null, storage_gb_per_member: 10, automation_runs: 20000, api_rpm: 120, history_days: 365, gantt: true, import_update: true, channels: true, automation: true, api: true, guests: true, sso: false, sla: false },
  team_l: { seats: 50, projects: null, storage_gb_per_member: 10, automation_runs: 50000, api_rpm: 300, history_days: 1095, gantt: true, import_update: true, channels: true, automation: true, api: true, guests: true, sso: false, sla: false },
  enterprise: { seats: null, projects: null, storage_gb_per_member: null, automation_runs: null, api_rpm: 1000, history_days: null, gantt: true, import_update: true, channels: true, automation: true, api: true, guests: true, sso: true, sla: true },
};

/** อ่าน matrix จากฐานข้อมูล · คีย์ที่ขาด (เพิ่มทีหลัง) ใช้ค่าตั้งต้น · ค่าผิดชนิดถูกทิ้ง */
export function normalizeMatrix(raw: unknown): Matrix {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Record<string, unknown> | undefined>;
  const out = {} as Matrix;
  for (const plan of ENTITLEMENT_PLANS) {
    out[plan] = {};
    for (const k of ENTITLEMENT_KEYS) {
      const v = src[plan]?.[k.key];
      const ok = k.kind === 'feature' ? typeof v === 'boolean' : v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 0);
      out[plan][k.key] = ok ? (v as EntitlementValue) : DEFAULT_MATRIX[plan][k.key];
    }
  }
  return out;
}

/** a ให้มากกว่า b ไหม · null (ไม่จำกัด) มากที่สุด · true > false */
export function moreGenerous(a: EntitlementValue, b: EntitlementValue): boolean {
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === true && b !== true;
  if (a === null) return b !== null;
  if (b === null) return false;
  return a > b;
}

/** รายการที่เวอร์ชันใหม่ให้น้อยลง (ใช้นับลูกค้าที่กระทบ และคงค่าเดิมจนจบรอบบิล) */
export function reductions(from: Matrix, to: Matrix) {
  const out: { plan: EntitlementPlan; key: string; from: EntitlementValue; to: EntitlementValue }[] = [];
  for (const plan of ENTITLEMENT_PLANS) for (const { key } of ENTITLEMENT_KEYS) if (moreGenerous(from[plan][key], to[plan][key])) out.push({ plan, key, from: from[plan][key], to: to[plan][key] });
  return out;
}

export function changes(from: Matrix, to: Matrix) {
  const out: { plan: EntitlementPlan; key: string; from: EntitlementValue; to: EntitlementValue; reduced: boolean }[] = [];
  for (const plan of ENTITLEMENT_PLANS) for (const { key } of ENTITLEMENT_KEYS) if (from[plan][key] !== to[plan][key]) out.push({ plan, key, from: from[plan][key], to: to[plan][key], reduced: moreGenerous(from[plan][key], to[plan][key]) });
  return out;
}

type Reader = Db | Tx;

/** เวอร์ชันที่มีผล ณ เวลานั้น · ไม่มีแถวเลย (ฐานข้อมูลที่ถูกล้างตอนทดสอบ) → เวอร์ชัน 0 = ค่าตั้งต้น */
export async function versionAt(db: Reader, at: Date) {
  const [row] = await db.select().from(entitlementVersions).where(lte(entitlementVersions.effectiveAt, at)).orderBy(desc(entitlementVersions.version)).limit(1);
  return row ? { version: row.version, effectiveAt: row.effectiveAt, matrix: normalizeMatrix(row.matrix) } : { version: 0, effectiveAt: new Date(0), matrix: DEFAULT_MATRIX };
}

export async function activeOverrides(db: Reader, workspaceId: string, now = new Date()) {
  return db
    .select()
    .from(entitlementOverrides)
    .where(and(eq(entitlementOverrides.workspaceId, workspaceId), isNull(entitlementOverrides.revokedAt), or(isNull(entitlementOverrides.expiresAt), gt(entitlementOverrides.expiresAt, now))));
}

export interface ResolvedEntitlements {
  version: number;
  /** ค่าที่ใช้จริงหลังรวมช่วงผ่อนผันและ override · คีย์ตาม ENTITLEMENT_KEYS */
  values: Record<string, EntitlementValue>;
  /** พื้นที่รวมจาก override (GB) · undefined = ใช้สูตร GB ต่อคน */
  storageGbTotal?: number | null;
  /** คีย์ที่ใช้ค่าเดิมระหว่างรอจบรอบบิล */
  grace: string[];
  overrides: { key: string; value: EntitlementValue; expiresAt: Date | null }[];
}

/**
 * สิทธิ์ที่ Workspace ใช้ได้ตอนนี้
 * `cycleStart` = วันเริ่มรอบบิลปัจจุบัน (ไม่มี = Free / ทดลอง ไม่มีช่วงผ่อนผัน) · ถ้ารอบเริ่มก่อนเวอร์ชันปัจจุบันมีผล ใช้ค่าที่ดีกว่าระหว่างเวอร์ชัน ณ ต้นรอบกับเวอร์ชันปัจจุบัน
 */
export async function resolveEntitlements(db: Reader, workspaceId: string, plan: EntitlementPlan, cycleStart: Date | null, now = new Date()): Promise<ResolvedEntitlements> {
  const current = await versionAt(db, now);
  const values = { ...current.matrix[plan] };
  const grace: string[] = [];
  if (cycleStart && current.version > 0 && cycleStart < current.effectiveAt) {
    const before = await versionAt(db, cycleStart);
    if (before.version !== current.version) {
      for (const { key } of ENTITLEMENT_KEYS) {
        if (moreGenerous(before.matrix[plan][key], values[key])) {
          values[key] = before.matrix[plan][key];
          grace.push(key);
        }
      }
    }
  }
  const rows = await activeOverrides(db, workspaceId, now);
  let storageGbTotal: number | null | undefined;
  for (const o of rows) {
    const v = o.value as EntitlementValue;
    if (o.key === 'storage_gb') storageGbTotal = typeof v === 'number' || v === null ? v : undefined;
    else values[o.key] = v;
  }
  return { version: current.version, values, storageGbTotal, grace, overrides: rows.map((o) => ({ key: o.key, value: o.value as EntitlementValue, expiresAt: o.expiresAt })) };
}
