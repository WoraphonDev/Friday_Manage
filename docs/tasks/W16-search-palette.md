# W16 · ค้นหาและ Command palette (Ctrl K)

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A22 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/w/[ws]/search/**` · `apps/web/src/features/command-palette/**` · `apps/web/messages/th/search-palette.json` |
| หน้าจอ | P1 (`design/canvas/Search.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · `GET w/search` (A22) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- หน้าค้นหาพร้อมตัวกรอง, palette ค้นงาน / โปรเจกต์ / คน / คำสั่ง, `#DP-39`, `@ชื่อ`, การค้นหาที่บันทึก

## เสร็จเมื่อ

- [ ] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [ ] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [ ] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [ ] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
