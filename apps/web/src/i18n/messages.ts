import common from "../../messages/th/common.json";
import inboxBell from "../../messages/th/inbox-bell.json";

// เพิ่ม namespace ต่องานที่นี่ แยกข้อความของแต่ละหน้าออกจากไฟล์กลาง
// inbox-bell: กระดิ่งอยู่ใน shell ทุกหน้า จึงต้องมีข้อความเสมอ (รวมใน test ที่ render shell)
export const messages = { common, "inbox-bell": inboxBell };
