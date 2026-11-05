# W06 · Kanban (รวมมือถือ)

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/w/[ws]/p/[key]/board/**` · `apps/web/messages/th/kanban.json` |
| หน้าจอ | 3 (`design/canvas/Kanban.dc.html`) · M7 (`design/canvas/MobileKanban.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · `GET p/board`, `POST i/move` (มีแล้ว) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- คอลัมน์ + WIP, การ์ดตามหน้าจอ, ลาก (ข้ามคอลัมน์ / เรียงลำดับด้วย afterKey / beforeKey), ปุ่ม ‹ › สำหรับคีย์บอร์ดและมือถือ, ยืนยันย้ายเมื่อ `subtasks_incomplete`, เลิกทำ, Swimlane (Module / Assignee / Priority) จัดกลุ่มฝั่งหน้าเว็บ, Show older
- สลับบอร์ด Bug (`?type=bug`)

## เสร็จเมื่อ

- [x] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [x] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [x] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

- แทน placeholder ด้วย Kanban จริง: คอลัมน์/WIP, cards และ Bug status จริง, Module/งานของฉัน/Overdue/ระดับงาน, Swimlane Module/Assignee/Priority, Show older และสลับ `?type=bug`
- ลากข้ามคอลัมน์/เรียงลำดับด้วยเพื่อนบ้าน `afterKey`/`beforeKey`; ปุ่ม ‹ › และ ↑ ↓ รวมการเรียงตามการ์ดที่มองเห็นหลังกรอง; มือถือเลือกคอลัมน์และย้ายผ่าน Dialog ได้ ตัวกรองพับได้
- ทุกการย้ายและ Undo ส่ง If-Match; ไม่ย้ายการ์ดล่วงหน้าก่อน API สำเร็จ, แสดง conflict/requestId, ยืนยัน `subtasks_incomplete` ได้ทั้งการย้ายและ Undo; Undo ของ Bug คืนสถานะจริงเดิม; เปลี่ยน Workspace/Project แล้วล้าง state ทั้งหมด
- ใช้ UI kit ของ W00; ข้อความของหน้าอยู่ `kanban.json` และ component กลางใช้ namespace ของ UI kit ตามเดิม ปุ่มเขียนซ่อนตาม my-permissions; Guest/HTTP403 ใช้ Forbidden
- เพิ่ม component/MSW tests 21 ข้อใน **ไฟล์ใหม่** `src/lib/kanban.test.tsx` ตามข้อยกเว้นไฟล์กลางที่งานเว็บเพิ่มไฟล์ได้ เพื่อให้ `pnpm test`/CI เดิมซึ่งค้นเฉพาะ `src/**/*.test.*` รันชุดใหม่นี้ด้วย ไม่เปลี่ยน config/ไฟล์กลางเดิม
- ตรวจภาพจริงจาก Chrome ที่ CSS 1440×1000 และ 390×844 (DPR2) อยู่ `_qa/`; ภาพมือถือเป็นรอบก่อนเพิ่มการพับตัวกรอง จากนั้นตรวจ mobile layout ที่พับตัวกรองผ่าน native preview และ MSW เพิ่มเติม Shell/Project header ใช้ของ W00 จึงต่างจาก header มือถือใน Canvas M7; ไม่แก้ไฟล์นอก lane
- Real API smoke บนฐานแยก `friday_w06` ผ่าน: cross-column move, If-Match/Undo, Bug Open→Fixed→Open และ 422/confirm ของ Parent ที่ Sub-task ยังไม่เสร็จ Browser ตรวจการเปิด Drawer และ conflict/requestId ได้; เครื่องมือ native browser มีอาการ index เปลี่ยนระหว่างตรวจ จึงยืนยัน mutation flows ครบด้วย MSW และ real API smoke
- ไม่เพิ่ม Add column เพราะเป็นการตั้งค่า Workflow ของ W13/A05; ไม่แสดงข้อมูล Git PR ที่ Board API ยังไม่ส่งมา ไม่สร้างข้อมูลสมมติบนหน้าจอจริง
- ผลตรวจสุดท้าย: `pnpm typecheck` และ `pnpm test` ทั้ง workspace ผ่าน Web52 + DB105 + API54 =211 tests; opt-in เดิม2 skipped ตามเดิม และ web production build ผ่าน ไม่เพิ่ม dependency
