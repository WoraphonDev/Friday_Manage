// แยกจาก legal.tsx ("use client") เพื่อให้ page.tsx ฝั่ง server ใช้ค่าจริงได้
export const LEGAL_TYPES = ["terms", "privacy", "dpa", "cookie", "subprocessors"] as const;
export type LegalType = (typeof LEGAL_TYPES)[number];
export const isLegalType = (v: string): v is LegalType => (LEGAL_TYPES as readonly string[]).includes(v);
