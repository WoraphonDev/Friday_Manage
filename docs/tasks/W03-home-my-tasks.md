# W03 · Home และ My Tasks (รวมมือถือ)

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A10 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/w/[ws]/page.tsx` · `apps/web/app/w/[ws]/my-tasks/**` · `apps/web/messages/th/home-my-tasks.json` |
| หน้าจอ | E (`design/canvas/Home.dc.html`) · F (`design/canvas/MyTasks.dc.html`) · M2 (`design/canvas/MobileMyTasks.dc.html`) · M5 (`design/canvas/MobileHome.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · 03-api › 2 หน้า E, F |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- ตามหน้าจอทั้ง desktop และมือถือ · ลากไปกลุ่ม "สัปดาห์หน้า" = แก้ Due หรือเปิด K3 ตามสิทธิ์
- อนุมัติคำขอเลื่อน Due จาก Home

## เสร็จเมื่อ

- [ ] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [ ] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [ ] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [ ] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
