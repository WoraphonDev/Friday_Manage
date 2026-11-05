# W14 · Import Excel และการแก้ไขแผน

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A07 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/w/[ws]/import/**` · `apps/web/app/w/[ws]/p/[key]/plan-changes/**` · `apps/web/messages/th/import-plan-changes.json` |
| หน้าจอ | L3 (`design/canvas/ImportExcel.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · 03-api › 3.6 แถว import-jobs, plan-changes |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- อัปโหลด → จับคู่คอลัมน์ / คน → ผลตรวจ → นำเข้า (โหมดสร้างใหม่มีแล้ว, โหมดอัปเดตเมื่อ A15 merge)
- แท็บการแก้ไขแผน + Export

## เสร็จเมื่อ

- [ ] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [ ] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [ ] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [ ] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
