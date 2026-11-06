// W21 · ข้อความของตัวสลับภาษาเอง แยกตามภาษาไว้ใน feature
// เพราะตัวสลับต้องแสดงได้ทุกหน้า (รวมหน้าสาธารณะและ test ที่ไม่ได้โหลดทุก namespace)
// และ lane ของงานนี้ไม่มี messages/th ของตัวเอง · ย้ายเข้า messages/<locale>/locale-switch.json ได้ภายหลัง
import type { AppLocale } from "./locale";

export const LABELS = {
  th: {
    language: "ภาษาของระบบ",
    yearFormat: "รูปแบบปี",
    BE: "พ.ศ.",
    CE: "ค.ศ.",
    yearHint: "ค่าเริ่มต้น: ภาษาไทย = พ.ศ. · English = ค.ศ.",
    failed: "เปลี่ยนภาษาไม่สำเร็จ กรุณาลองอีกครั้ง",
  },
  en: {
    language: "Language",
    yearFormat: "Year format",
    BE: "B.E.",
    CE: "A.D.",
    yearHint: "Default: Thai = B.E. · English = A.D.",
    failed: "Couldn't change the language. Please try again",
  },
} satisfies Record<AppLocale, Record<string, string>>;
