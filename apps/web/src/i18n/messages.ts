import common from "../../messages/th/common.json";
import inboxBell from "../../messages/th/inbox-bell.json";
import searchPalette from "../../messages/th/search-palette.json";

// เพิ่ม namespace ต่องานที่นี่ แยกข้อความของแต่ละหน้าออกจากไฟล์กลาง
// inbox-bell, search-palette: กระดิ่งและ Command palette อยู่ใน shell ทุกหน้า
// จึงต้องมีข้อความเสมอ (รวมใน test ที่ render shell)
export const messages = {
  common,
  "inbox-bell": inboxBell,
  "search-palette": searchPalette,
};
