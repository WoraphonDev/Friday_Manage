# A06 · Sprint และ Backlog

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | — เริ่มได้เลย |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/sprints/**` · `apps/api/test/sprints.e2e.test.ts` |
| หน้าจอ | L1 (`design/canvas/Backlog.dc.html`) |
| สเปก | 03-api › 3.6 แถว `p/sprints` · 03-api › 2 หน้า L1 |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `POST / PATCH p/sprints` · `POST p/sprints/{id}/start` (มี active ได้ทีละ 1 → 409) · `POST p/sprints/{id}/complete` `{ moveIncompleteTo: sprintId | "backlog", retrospective }` (Sub-task ย้ายตามงานแม่)
- `GET p/backlog`: Sprint ที่ยังไม่จบ + Backlog (งานระดับ Task ที่ไม่มี Sprint) เรียงตาม rank · capacity ต่อ Sprint (capacity สมาชิก × วันทำการ − วันลา) เทียบ MD ที่ใส่ไว้ · Burndown ของ Sprint ที่ active (เส้นอุดมคติ + จริง)
- Burndown จริง: upsert `sprint_daily_snapshots` ของวันนี้ทุกครั้งที่มีคนเปิด `GET p/backlog` (ยังไม่มีคิว) · export `snapshotAll()` ให้ A16 ตั้งเวลาทีหลัง
- Event `sprint.started`, `sprint.completed`

## กติกาที่ต้องตรง

- ต้องมี `sprint.manage` สำหรับสร้าง / เริ่ม / จบ
- ย้ายงานเข้า Sprint ใช้ `POST i/move` ที่มีอยู่แล้ว

## เสร็จเมื่อ

- [ ] test ครอบคลุมทุกข้อ รวมจบ Sprint แล้วงานค้างย้ายไป Sprint ถัดไป
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
