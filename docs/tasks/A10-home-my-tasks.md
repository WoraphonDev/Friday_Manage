# A10 · Home และ My Tasks

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | — เริ่มได้เลย |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/home/**` · `apps/api/test/home.e2e.test.ts` |
| หน้าจอ | E (`design/canvas/Home.dc.html`) · F (`design/canvas/MyTasks.dc.html`) · M2 (`design/canvas/MobileMyTasks.dc.html`) · M5 (`design/canvas/MobileHome.dc.html`) |
| สเปก | 03-api › 2 หน้า E และ F |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `GET w/home`: สรุปวันนี้ (ครบกำหนดวันนี้ / เลยกำหนด / กำลังทำ ของฉัน), รออนุมัติ (ใช้ `DueRequestsService.list` โดย import `DueRequestsModule`), รอ Review (ฉันเป็น Reviewer และสถานะชื่อ Review), โปรเจกต์ของฉันพร้อมความคืบหน้า, งานที่ฉันแตะล่าสุด (จาก `activities`), ครบกำหนดใน 30 วัน
- `GET w/my-issues?tab=assigned|reviewer|watching|created&group=due|project|status` · group=due แบ่ง เลยกำหนด / วันนี้ / สัปดาห์นี้ / สัปดาห์หน้า / ภายหลัง / ไม่มีวันที่
- ถ้า A08 merge แล้ว ใช้ `overview/workload.ts` แสดง Workload สัปดาห์นี้ของฉันใน Home

## กติกาที่ต้องตรง

- ข้ามทุกโปรเจกต์ที่เข้าถึงได้ (RLS) · Guest ที่เป็น Viewer เห็นเฉพาะงานที่แชร์

## เสร็จเมื่อ

- [ ] test ครอบคลุมทุก tab และ group
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
