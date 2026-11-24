/** QR PromptPay ใช้ได้ 15 นาทีนับจากสร้าง (หน้าจอ Checkout 4b) · ครบแล้วปิดรายการที่ผู้ให้บริการ ลูกค้ากดสร้าง QR ใหม่ในใบเดิม */
export const QR_TTL_MS = 15 * 60_000;

/**
 * วันที่ตัดบัตรของใบต่ออายุ นับจากวันเริ่มรอบใหม่ (วันที่ 0) · ล้มแล้วลองใหม่วันที่ 1, 3, 5 (Canvas Friday Ops › ช่องทางรับชำระ)
 * ครบทุกครั้งแล้วยังไม่ผ่าน → ส่งลิงก์ชำระให้ลูกค้า และให้ทีมการเงินตามต่อ
 */
export const CARD_ATTEMPT_DAYS = [0, 1, 3, 5] as const;

const DAY_MS = 86_400_000;

/** จำนวนวันระหว่างวันที่สองวัน (YYYY-MM-DD) */
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * ตัดครั้งถัดไปได้หรือยัง · `attempts` = จำนวนครั้งที่ตัดไปแล้วของใบนี้ · `day` = วันที่เท่าไรของรอบ
 * คืน null เมื่อครบทุกครั้งแล้ว
 */
export function cardAttemptDue(attempts: number, day: number): { due: boolean; attempt: number; final: boolean } | null {
  if (attempts >= CARD_ATTEMPT_DAYS.length) return null;
  return { due: day >= CARD_ATTEMPT_DAYS[attempts], attempt: attempts + 1, final: attempts + 1 === CARD_ATTEMPT_DAYS.length };
}

/** วันที่ลองครั้งถัดไป (YYYY-MM-DD) หลังครั้งที่ `attempt` ล้ม · null = ไม่มีแล้ว */
export function nextAttemptOn(periodStart: string, attempt: number): string | null {
  const day = CARD_ATTEMPT_DAYS[attempt];
  if (day === undefined) return null;
  return new Date(Date.parse(`${periodStart}T00:00:00Z`) + day * DAY_MS).toISOString().slice(0, 10);
}
