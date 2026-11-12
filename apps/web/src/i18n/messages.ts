import common from "../../messages/th/common.json";
import inboxBell from "../../messages/th/inbox-bell.json";
import saasPages from "../../messages/th/saas-pages.json";
import searchPalette from "../../messages/th/search-palette.json";
import localeSwitch from "../../messages/th/locale-switch.json";
import localeSwitchEn from "../../messages/en/locale-switch.json";
import commonEn from "../../messages/en/common.json";
import inboxBellEn from "../../messages/en/inbox-bell.json";
import saasPagesEn from "../../messages/en/saas-pages.json";
import searchPaletteEn from "../../messages/en/search-palette.json";
import suspension from "../../messages/th/suspension.json";
import suspensionEn from "../../messages/en/suspension.json";
import announcements from "../../messages/th/announcements.json";
import announcementsEn from "../../messages/en/announcements.json";

// เพิ่ม namespace ต่องานที่นี่ แยกข้อความของแต่ละหน้าออกจากไฟล์กลาง
// inbox-bell, search-palette: กระดิ่งและ Command palette อยู่ใน shell ทุกหน้า
// จึงต้องมีข้อความเสมอ (รวมใน test ที่ render shell)
// saas-pages: Dialog 402 (providers) และแบนเนอร์แพ็กเกจ (shell) ของ W19
export const messages = {
  common,
  "inbox-bell": inboxBell,
  "search-palette": searchPalette,
  "saas-pages": saasPages,
  // locale-switch: ตัวสลับภาษา / ปี / ธีม อยู่ใน shell และหน้าสาธารณะทุกหน้า (W21)
  "locale-switch": localeSwitch,
  // suspension: แถบ / หน้า Workspace ถูกระงับ (C6) อยู่ใน shell
  suspension,
  // announcements: แบนเนอร์ประกาศจากทีม Friday (O24) อยู่ใน shell
  announcements,
};

/** ข้อความ EN ของ namespace เดียวกัน (W21) · test ใช้ผ่าน renderWithProviders({ locale: "en" }) */
export const messagesEn = {
  common: commonEn,
  "inbox-bell": inboxBellEn,
  "search-palette": searchPaletteEn,
  "saas-pages": saasPagesEn,
  "locale-switch": localeSwitchEn,
  suspension: suspensionEn,
  announcements: announcementsEn,
};
