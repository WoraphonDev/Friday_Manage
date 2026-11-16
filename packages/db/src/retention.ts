// ระยะเก็บข้อมูลและ Legal hold (รอบ 4 · H10–H13) · ใช้ร่วมกันระหว่าง apps/api (งานลบถาวรตามเวลา) และ apps/ops-api (ตั้งค่า / ลบทันที)
// ทุกงานลบถาวรต้องถาม heldScope() ก่อน: ข้อมูลที่ติด Legal hold ห้ามลบแม้ครบกำหนดหรือมีคำขอลบ
import { eq, isNull } from 'drizzle-orm';
import type { Db, Tx } from './client.ts';
import { legalHolds, opsSettings } from './schema/ops.ts';

/** คีย์ใน ops_settings */
export const RETENTION_KEY = 'retention';

/**
 * ค่าเริ่มต้นเมื่อยังไม่ได้ตั้ง (วัน) · tax = ใบกำกับภาษีและหลักฐานการชำระ 5 ปีตามประมวลรัษฎากร แก้ไม่ได้
 * Activity / Audit log ของลูกค้าตามแพ็กเกจอยู่ใน entitlements ไม่ใช่ที่นี่
 */
export const RETENTION_DEFAULTS = { workspaceDataDays: 90, trashDays: 30, systemLogDays: 90, staffAuditDays: 730 } as const;
export type RetentionKey = keyof typeof RETENTION_DEFAULTS;
export type Retention = Record<RetentionKey, number>;
export const RETENTION_KEYS = Object.keys(RETENTION_DEFAULTS) as RetentionKey[];
/** ขอบเขตที่ตั้งได้ (วัน) */
export const RETENTION_LIMITS: Record<RetentionKey, { min: number; max: number }> = {
  workspaceDataDays: { min: 30, max: 365 },
  trashDays: { min: 7, max: 90 },
  systemLogDays: { min: 30, max: 365 },
  staffAuditDays: { min: 365, max: 3650 },
};
export const TAX_RETENTION_YEARS = 5;

/** ค่าที่ใช้จริง: ค่าที่ทีมตั้งใน ops_settings ทับค่าเริ่มต้น · ค่าที่อยู่นอกขอบเขตไม่ใช้ (กันค่าเสียทำให้ลบเกิน) */
export function retentionOf(raw: unknown): Retention {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...RETENTION_DEFAULTS } as Retention;
  for (const k of RETENTION_KEYS) {
    const n = v[k];
    if (typeof n === 'number' && Number.isInteger(n) && n >= RETENTION_LIMITS[k].min && n <= RETENTION_LIMITS[k].max) out[k] = n;
  }
  return out;
}

/** อ่านระยะเก็บข้อมูล · ต้องเป็นการเชื่อมต่อที่ข้าม RLS (ops_settings เป็นของทีม Friday) */
export async function readRetention(db: Db | Tx): Promise<Retention> {
  const [row] = await db.select({ value: opsSettings.value }).from(opsSettings).where(eq(opsSettings.key, RETENTION_KEY));
  return retentionOf(row?.value);
}

export interface HeldScope {
  /** Workspace ที่มี hold ใด ๆ (ทั้ง Workspace หรือเฉพาะผู้ใช้) · ใช้กับงานที่ลบทั้งก้อน เช่น ลบ Workspace ถาวร */
  anyHold: Set<string>;
  /** Workspace ที่ hold ทั้งก้อน · งานลบรายแถว (ถังขยะ Log) ข้ามทั้ง Workspace */
  wholeWorkspace: Set<string>;
  /** ผู้ใช้ที่ติด hold (เฉพาะผู้ใช้บางคน) · คำขอลบ PDPA ของคนเหล่านี้ต้องรอ */
  users: Set<string>;
  isHeld(workspaceId: string, userId?: string | null): boolean;
}

/** Legal hold ที่ยังไม่ยกเลิก · ต้องเป็นการเชื่อมต่อที่ข้าม RLS (legal_holds เป็นของทีม Friday) */
export async function heldScope(db: Db | Tx): Promise<HeldScope> {
  const rows = await db.select({ workspaceId: legalHolds.workspaceId, scope: legalHolds.scope, userIds: legalHolds.userIds }).from(legalHolds).where(isNull(legalHolds.releasedAt));
  const anyHold = new Set<string>();
  const wholeWorkspace = new Set<string>();
  const users = new Set<string>();
  for (const r of rows) {
    anyHold.add(r.workspaceId);
    if (r.scope === 'workspace') wholeWorkspace.add(r.workspaceId);
    else for (const u of r.userIds) users.add(u);
  }
  return { anyHold, wholeWorkspace, users, isHeld: (w, u) => wholeWorkspace.has(w) || (!!u && users.has(u)) };
}
