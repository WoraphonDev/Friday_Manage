import { getRequestConfig } from "next-intl/server";
import {
  getRequestLocale,
  loadMessages,
} from "@/features/locale-switch/server";

// ภาษา: cookie NEXT_LOCALE (ตั้งจากบัญชีหรือตัวสลับ) → Accept-Language → ไทย (W21)
// ข้อความ EN วางทับไทย ข้อความที่ยังไม่แปลจึงแสดงเป็นไทยแทนรหัสข้อความ
// หมายเหตุ: อ่าน cookie ทำให้ทุกหน้า render แบบ dynamic (รวม /, /pricing, /legal/*)
export default getRequestConfig(async () => {
  const locale = await getRequestLocale();
  return {
    locale,
    messages: await loadMessages(locale),
    timeZone: "Asia/Bangkok",
  };
});
