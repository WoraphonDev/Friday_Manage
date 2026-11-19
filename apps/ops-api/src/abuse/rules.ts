import { z } from 'zod';

/**
 * โดเมนอีเมลชั่วคราวที่รู้จัก (O50) · อัปเดตผ่าน PR · โดเมนที่เจอเพิ่มให้ทีมเพิ่มเองในรายชื่อที่ถูกบล็อก (ชนิดโดเมนอีเมล) ซึ่งนับเป็นโดเมนชั่วคราวด้วย
 * ไม่ใส่ผู้ให้บริการอีเมลทั่วไป (gmail, outlook ฯลฯ) เพราะลูกค้าจริงใช้
 */
export const DISPOSABLE_DOMAINS: readonly string[] = [
  '10minutemail.com', '20minutemail.com', '33mailbox.com', 'burnermail.io', 'byom.de', 'discard.email', 'dispostable.com', 'dropmail.me',
  'emailondeck.com', 'fakeinbox.com', 'fakemail.net', 'getairmail.com', 'getnada.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamailblock.com',
  'harakirimail.com', 'inboxbear.com', 'incognitomail.org', 'mail-temp.com', 'mailcatch.com', 'maildrop.cc', 'mailinator.com', 'mailnesia.com',
  'mailpoof.com', 'mintemail.com', 'moakt.com', 'mohmal.com', 'mytemp.email', 'nada.email', 'sharklasers.com', 'spam4.me', 'spamgourmet.com',
  'temp-mail.io', 'temp-mail.org', 'tempail.com', 'tempinbox.com', 'tempmail.com', 'tempmail.dev', 'tempmail.net', 'tempmailo.com', 'tempr.email',
  'throwawaymail.com', 'tmpmail.net', 'tmpmail.org', 'trashmail.com', 'trashmail.de', 'yopmail.com', 'yopmail.fr', 'yopmail.net',
];

export const RULE_KEYS = ['temp_email', 'ip_burst', 'invite_burst', 'invite_links', 'unverified_heavy', 'card_declines', 'geo_mismatch', 'api_ratelimit'] as const;
export type RuleKey = (typeof RULE_KEYS)[number];
export type AbuseKind = 'fake_signup' | 'invite_spam' | 'api_abuse' | 'payment';

/** เกณฑ์ของสัญญาณ (ไม่ให้ปรับจากหน้าจอ เพื่อให้คะแนนเทียบกันได้ข้ามช่วงเวลา) */
export const IP_BURST = 5;
export const INVITE_BURST = 50;
export const HEAVY_ISSUES = 100;
export const HEAVY_INVITES = 20;
/** ชนเพดาน API ต่อเนื่องกี่นาที (ช่วงที่จบภายใน 1 ชม.) */
export const RATE_STREAK = 15;
/** ตัดสินเรื่องเดิมแล้ว ไม่เปิดเคสซ้ำภายใน 30 วัน (ไม่ใช่การใช้ผิด = ไม่รบกวนลูกค้าจริงซ้ำ · ระงับ / บล็อก = จัดการไปแล้ว) */
export const QUIET_DAYS = 30;
/** ระงับอัตโนมัติแล้วต้องมีคนยืนยันภายใน 24 ชม. · เกินแล้วแจ้ง Owner ซ้ำทุก 24 ชม. (ไม่ปลดเอง) */
export const CONFIRM_HOURS = 24;

/**
 * กฎตรวจจับ · `waiting` = ยังเปิดไม่ได้เพราะไม่มีข้อมูล (หน้าจอแสดงเหตุผล)
 * card_declines รอ Gateway จริง (A35b) · geo_mismatch รอฐานข้อมูล GeoIP · api_ratelimit ใช้สถิติรายนาทีของ O51 (api_usage_minutes)
 */
export const RULES: Record<RuleKey, { kind: AbuseKind; points: number; waiting?: 'A35b' | 'geoip' }> = {
  temp_email: { kind: 'fake_signup', points: 30 },
  ip_burst: { kind: 'fake_signup', points: 35 },
  invite_burst: { kind: 'invite_spam', points: 40 },
  invite_links: { kind: 'invite_spam', points: 24 },
  unverified_heavy: { kind: 'fake_signup', points: 20 },
  card_declines: { kind: 'payment', points: 45, waiting: 'A35b' },
  geo_mismatch: { kind: 'payment', points: 15, waiting: 'geoip' },
  api_ratelimit: { kind: 'api_abuse', points: 30 },
};

const RuleSetting = z.object({ points: z.number().int().min(0, 'คะแนนต้องไม่ติดลบ').max(100, 'คะแนนต่อกฎไม่เกิน 100'), on: z.boolean() }).strict();

export const AbuseSettings = z
  .object({
    /** คะแนนรวมถึงค่านี้ = เปิดเคสรอตรวจ */
    review: z.number().int().min(10).max(500),
    /** คะแนนรวมถึงค่านี้ = ระงับอัตโนมัติ (ต้องสูงกว่าเกณฑ์รอตรวจ) */
    autoSuspend: z.number().int().min(11).max(999),
    rules: z.object(Object.fromEntries(RULE_KEYS.map((k) => [k, RuleSetting])) as Record<RuleKey, typeof RuleSetting>).strict(),
  })
  .strict()
  .refine((v) => v.autoSuspend > v.review, { path: ['autoSuspend'], message: 'เกณฑ์ระงับอัตโนมัติต้องสูงกว่าเกณฑ์รอตรวจ' });
export type AbuseSettings = z.infer<typeof AbuseSettings>;

export const DEFAULT_SETTINGS: AbuseSettings = {
  review: 70,
  autoSuspend: 90,
  rules: Object.fromEntries(RULE_KEYS.map((k) => [k, { points: RULES[k].points, on: !RULES[k].waiting }])) as AbuseSettings['rules'],
};

export interface Signal {
  rule: RuleKey;
  points: number;
  detail: string;
  /** ค่าที่ใช้บล็อกต่อได้ (โดเมนชั่วคราว) */
  values?: string[];
}

/** ประเภทของเคส = ประเภทของสัญญาณที่ให้คะแนนมากสุด */
export function kindOf(signals: Signal[]): AbuseKind {
  const top = [...signals].sort((a, b) => b.points - a.points)[0];
  return top ? RULES[top.rule].kind : 'fake_signup';
}

export const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();
