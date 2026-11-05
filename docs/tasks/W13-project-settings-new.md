# W13 · Project Settings และสร้างโปรเจกต์ (Wizard)

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A04, A05 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/w/[ws]/p/[key]/settings/**` · `apps/web/app/w/[ws]/new-project/**` · `apps/web/messages/th/project-settings-new.json` |
| หน้าจอ | L2 (`design/canvas/ProjectSettings.dc.html`) · A (`design/canvas/NewProject.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · 03-api › 3.4, 3.5 |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- ทุกแท็บของ L2 (เรียก endpoint รายแท็บ) รวมตารางสิทธิ์ 10 แถว · แท็บที่ API ยังไม่มีแสดงว่ายังไม่เปิด
- Wizard 5 ขั้นตามหน้า A

## เสร็จเมื่อ

- [ ] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [ ] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [ ] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [ ] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
