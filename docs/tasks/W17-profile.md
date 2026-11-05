# W17 · Profile และการตั้งค่าแจ้งเตือนของฉัน

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A13, A20 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/w/[ws]/profile/**` · `apps/web/messages/th/profile.json` |
| หน้าจอ | I (`design/canvas/Profile.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · 03-api › 3.1, 3.9 แถว notification-prefs |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- ข้อมูลส่วนตัว, ภาษา / ปี, ตารางแจ้งเตือน, ผูก LINE, 2FA, Session, วันลา, iCal

## เสร็จเมื่อ

- [ ] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [ ] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [ ] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [ ] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
