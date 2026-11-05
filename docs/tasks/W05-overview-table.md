# W05 · Overview และ Table ของโปรเจกต์

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A03, A08 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/w/[ws]/p/[key]/page.tsx` · `apps/web/app/w/[ws]/p/[key]/table/**` · `apps/web/messages/th/overview-table.json` |
| หน้าจอ | 1 (`design/canvas/Main.dc.html`) · 2 (`design/canvas/Table.dc.html`) · M6 (`design/canvas/MobileOverview.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · 03-api › 2 หน้า 1, 2 |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- Overview ตามหน้าจอ (Health, KPI, Milestone, Burn-up, Workload สัปดาห์นี้)
- Table: Module › Task › Sub-task, ตัวกรองทั้งหมด, แก้ในแถว, เลือกหลายแถว (bulk), Saved view (ถ้า A22 merge แล้ว), virtualized สำหรับ 300+ แถว

## เสร็จเมื่อ

- [ ] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [ ] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [ ] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [ ] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
