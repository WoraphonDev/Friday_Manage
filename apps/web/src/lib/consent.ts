/** ความยินยอมคุกกี้ของหน้าสาธารณะ (R4) เก็บในเบราว์เซอร์ (03-api: ไม่มี endpoint) · เปลี่ยนเวอร์ชันเมื่อหมวดคุกกี้เปลี่ยนเพื่อถามใหม่ */
export const CONSENT_KEY = "fm_cookie_consent";
export const CONSENT_VERSION = 1;
/** แบนเนอร์บันทึกความยินยอมแล้ว · ตัวเก็บที่มาของผู้ใช้ฟังเพื่อเขียน cookie ทันทีที่ยินยอม */
export const CONSENT_CHANGED = "friday:cookie-consent";

export interface CookieConsentValue {
  v: number;
  necessary: true;
  analytics: boolean;
  marketing: boolean;
  at: string;
}

export function readConsent(): CookieConsentValue | null {
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    const value = raw ? (JSON.parse(raw) as CookieConsentValue) : null;
    return value?.v === CONSENT_VERSION ? value : null;
  } catch {
    return null;
  }
}
