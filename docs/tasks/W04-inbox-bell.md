# W04 · Inbox และกระดิ่ง

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/w/[ws]/inbox/**` · `apps/web/src/features/bell/**` · `apps/web/messages/th/inbox-bell.json` |
| หน้าจอ | G (`design/canvas/Inbox.dc.html`) · K4 (`design/canvas/Bell.dc.html`) · M3 (`design/canvas/MobileInbox.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · 03-api › 3.9 แถว `me/notifications*` |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- ตัวกรอง 6 แบบพร้อมจำนวน, แผงรายละเอียดขวา, อนุมัติ / ปฏิเสธคำขอเลื่อน Due (`canDecide`), รับทราบ, เตือนพรุ่งนี้, Mark all as read
- กระดิ่ง + Toast จาก Realtime (ถ้า A17 merge แล้ว ไม่งั้น poll 60 วินาที)

## เสร็จเมื่อ

- [ ] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [ ] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [ ] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [ ] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
