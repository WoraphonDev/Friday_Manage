import { z } from 'zod';

/**
 * ตัวกรองชุดเดียวกับ GET ops/workspaces (ไม่รวมการเรียง / แบ่งหน้า) · ใช้ทั้งรายการ งานหลายราย (H4) ป้ายทดสอบ และมุมมองที่บันทึกไว้
 * ช่วง 3: เพิ่มสุขภาพ ที่นั่ง การใช้งาน ทดลอง ค้างชำระ รอบบิล วันสมัคร ช่องทาง ผู้ดูแล Ticket MRR
 * ค่าเลือกหลายค่า (แพ็กเกจ สุขภาพ) ส่งคั่นด้วยจุลภาค
 */
export const PLAN_CODES = ['free', 'team_s', 'team_m', 'team_l', 'enterprise'] as const;
export const FEATURES = ['line', 'webhook', 'github', 'api_token', 'automation', 'import', 'no_project'] as const;

/** "a,b" หรือ ["a","b"] → ["a","b"] (ว่าง = ไม่กรอง) */
const many = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)).max(values.length))
    .optional();
const satang = z.coerce.number().int().min(0).max(1_000_000_000).optional();
const days = <T extends number>(...values: [T, T, ...T[]]) => z.coerce.number().pipe(z.union(values.map((v) => z.literal(v)) as unknown as [z.ZodLiteral<T>, z.ZodLiteral<T>])).optional();

export const FILTER_FIELDS = {
  plan: many(PLAN_CODES),
  /** paying = แพ็กเกจจ่ายเงินอยู่ (สถานะแพ็กเกจ active · แท็บ "จ่ายเงิน") */
  status: z.enum(['trial', 'active', 'suspended', 'pending_delete', 'trialing', 'canceled', 'past_due', 'paying']).optional(),
  q: z.string().trim().max(100).optional(),
  feature: z.enum(FEATURES).optional(),
  buyer: z.string().trim().max(80).optional(),
  /** บัญชีลูกค้า (ช่วง 3) */
  account: z.uuid().optional(),
  test: z.enum(['hide', 'only', 'all']).default('hide'),
  suggest: z.enum(['any', 'staff_domain', 'name_prefix']).optional(),
  /** สุขภาพ: low < 40 · mid 40–69 · high ≥ 70 (คำนวณในโค้ด) */
  health: many(['low', 'mid', 'high'] as const),
  /** ที่นั่ง: near ≥ 80% · full ≥ 100% · under < 50% ของแพ็กเกจ */
  seats: z.enum(['near', 'full', 'under']).optional(),
  /** ใช้งานล่าสุด: active7 = มีคนใช้ใน 7 วัน · idle14 / idle30 = ไม่มีใครใช้ */
  activity: z.enum(['active7', 'idle14', 'idle30']).optional(),
  /** ทดลองหมดภายใน (วัน) */
  trialEnds: days(3, 7, 14),
  /** ค้างชำระมาเกิน (วัน) */
  overdueDays: days(7, 30, 60),
  cycle: z.enum(['monthly', 'yearly']).optional(),
  /** สมัครภายใน (วัน) หรือช่วงวันที่ */
  created: days(7, 30, 90),
  createdFrom: z.iso.date().optional(),
  createdTo: z.iso.date().optional(),
  /** ช่องทางที่มา (workspace_acquisitions.source · direct = ไม่มีข้อมูล) */
  source: z.string().trim().max(60).optional(),
  /** ผู้ดูแลบัญชี: รหัสพนักงาน หรือ none */
  manager: z.union([z.uuid(), z.literal('none')]).optional(),
  tickets: z.enum(['open', 'none']).optional(),
  /** ช่วง MRR (สตางค์) · เฉพาะคนที่เห็นเงิน */
  mrrMin: satang,
  mrrMax: satang,
};
export const BulkFilter = z.object(FILTER_FIELDS).strict();
export type Filters = z.infer<typeof BulkFilter>;
