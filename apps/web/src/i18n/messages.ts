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
import whatsNew from "../../messages/th/whats-new.json";
import whatsNewEn from "../../messages/en/whats-new.json";
import onboardingChecklist from "../../messages/th/onboarding-checklist.json";
import onboardingChecklistEn from "../../messages/en/onboarding-checklist.json";
import trash from "../../messages/th/trash.json";
import trashEn from "../../messages/en/trash.json";
import help from "../../messages/th/help.json";
import helpEn from "../../messages/en/help.json";

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
  // whats-new: ปุ่มมีอะไรใหม่ / Spotlight / NPS (W24) อยู่ใน shell
  "whats-new": whatsNew,
  // onboarding-checklist: ปุ่มเริ่มต้นใช้งานท้าย Sidebar และเมนูบัญชี (W25) อยู่ใน shell
  "onboarding-checklist": onboardingChecklist,
  // trash: หน้า Workspace ที่ลบไว้ (Z5) และส่วน "ลบไว้" ในตัวสลับ Workspace อยู่ใน shell (W23)
  trash,
  // help: ปุ่มและแผงช่วยเหลือ (X4) อยู่บนแถบบนของ shell (W26)
  help,
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
  "whats-new": whatsNewEn,
  "onboarding-checklist": onboardingChecklistEn,
  trash: trashEn,
  help: helpEn,
};
