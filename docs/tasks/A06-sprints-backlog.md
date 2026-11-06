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

- [x] test ครอบคลุมทุกข้อ รวมจบ Sprint แล้วงานค้างย้ายไป Sprint ถัดไป
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

- เพิ่ม `POST p/sprints`, `PATCH p/sprints/{id}`, `POST p/sprints/{id}/start` และ `/complete` (รองรับ alias `:start` / `:complete` ตามเอกสารเดิมด้วย) · ตรวจ `sprint.manage`, วันที่ 1–366 วัน, PATCH รวมกับวันที่เดิม, แก้ได้เฉพาะ planning/active · สร้างเลข Sprint ภายใต้ project row lock, เริ่มพร้อมกันมีผู้ชนะคนเดียวและอีกคำขอได้ 409 พร้อม activeSprint
- Complete เฉพาะ active: ปลายทางเป็น planning ในโปรเจกต์/Workspace เดียวกัน หรือ `backlog` · งานแม่ที่สถานะยังไม่ Done ย้ายพร้อมลูกทุกสถานะ (รวมลูกที่ลบไว้เพื่อให้ restore กลับมาอยู่ Sprint ตามแม่); งานแม่ Done อยู่ Sprint เดิม · ล็อกแม่ก่อนลูก, อัปเดตใน transaction เดียว, เขียน Activity ของฟิลด์ sprintId และ Audit, เก็บ retrospective/completedAt/completedBy · Event `sprint.started` / `sprint.completed` ส่งหลัง commit เท่านั้น
- `GET p/backlog` ตอบ `{projectKey,asOf,permissions,sprints,backlog}`: Sprint ที่ยังไม่จบเรียง number, งานระดับบน (Task/Story/Bug/Spike ที่ไม่มีแม่) เรียง rank แล้ว number พร้อม `subtasks` · แต่ละ Sprint มี `stats`, `capacity`, `burndown` (planning เป็น null) · สถิตินับเฉพาะระดับล่างสุดเพื่อไม่รวม MD ของแม่/ลูกซ้ำ, ไม่นับงานที่ลบ · Guest Viewer ได้ 403; Viewer ปกติอ่านได้และปุ่มเขียนใช้ flags ใน permissions
- Capacity ใช้สมาชิกโปรเจกต์ที่ Workspace ยัง active: ชั่วโมงโปรเจกต์ → ชั่วโมง Workspace, หาร 8 ชม./MD และจำนวนวันทำงานต่อสัปดาห์, คูณวันทำการใน Sprint จาก WorkCalendar (วันหยุดหลัก/โปรเจกต์), หัก approved leave เต็ม/ครึ่งวัน ไม่หัก pending · ใช้ `computeWorkload` ของ A08 ในการคำนวณวันลา/เพดานหนึ่งวัน · MD ที่ commit แบ่งเท่ากันระหว่าง assignees ของงานระดับล่างสุด ไม่ต้องมีวันที่แผน · ส่งตัวเลขรวมและรายคน, overloaded, unassignedMd และ unavailableAssigneeMd · หาก PM/Viewer ไม่ให้เวลาโปรเจกต์นี้ให้ตั้ง capacityHoursWeek=0
- Burndown จริง upsert `(sprintId,date)` ด้วย `today()` เวลาไทยเมื่อ start, เปิด Backlog (ยกเว้น archived) และก่อน complete ย้ายงาน · คง snapshot วันอื่น; MD ที่เหลือ = estimate ของงานระดับล่างสุดที่ไม่ Done (ไม่ใช้ progress%) · เส้นอุดมคติใช้ MD รวมจาก snapshot วันเก่าสุดเป็นฐาน ลดเฉพาะวันทำการ ต้นวันแรกเต็มจำนวนและจบวันสุดท้ายเป็น 0; ไม่แต่งข้อมูลจริงย้อนหลังของวันที่ไม่มี snapshot · หากเพิ่ม scope ระหว่างวันแรก ค่า baseline ยังตาม snapshot วันแรกที่ upsert เพราะ schema ไม่มี baseline แยก
- Export `SprintsService.snapshotAll()` และตั้ง Jobs ของ A16 `sprints.snapshot` ทุกวัน 23:55 Asia/Bangkok ใน module ของตนเอง · SYSTEM_DB ใช้ค้นหา routing/context ข้าม Workspace เท่านั้น แล้วอ่าน/เขียน snapshot ผ่าน TenantDb/RLS · เลือก Project Owner ที่ active หรือสมาชิก active ที่อ่านงานครบได้ (ไม่ใช้ Guest Viewer); ถ้าไม่มีบัญชีดังกล่าวจะไม่มี context สำหรับ snapshot จนมีสมาชิก active อีกครั้ง · ข้ามโปรเจกต์/Workspace ที่ลบและโปรเจกต์ archived; โหมด inline จำ schedule แต่ไม่รันอัตโนมัติตาม A16
- **คำขอนอก lane ก่อน merge:** `IssuesService.checkInProject()` ของ A03 ตรวจ Sprint เพียงอยู่ในโปรเจกต์เดียวกัน ปัจจุบัน create/patch/move/bulk จึงยังใส่งานเข้า Sprint ที่ completed ได้ และ move ไม่ใช้ project lock ร่วมกับ complete ทำให้มีโอกาสย้ายงานเข้า Sprint ระหว่างที่ปิด Sprint · ขอ A03 ตรวจสถานะปลายทางและใช้ project lock ลำดับเดียวกันก่อนเปลี่ยน Sprint (create ใช้ project lock จากเลข issue_seq อยู่แล้ว) · งานนี้คงใช้ `POST i/move` เดิมตามกติกาและไม่แก้ไฟล์กลาง
- Test ใหม่ 18 ข้อใน `test/sprints.e2e.test.ts` เริ่มจาก startApp + seedTeam: lifecycle, สร้าง/เริ่มพร้อมกัน, Event หลัง commit, ย้ายงานค้าง/ลูกไป Sprint ถัดไป/Backlog, invalid destination/rollback, rank/MD, capacity/วันหยุด/วันลา/สมาชิก inactive, snapshot history/upsert/Jobs/RLS เมื่อ owner inactive, permissions/Guest/Archived, invalid input และข้าม Workspace · `pnpm typecheck`, `pnpm test` และ `pnpm -r --if-present build` ผ่าน · ใช้ฐานข้อมูลสมมติ `friday_a06` แยกจากงานอื่น; หลัง rebase บน main ที่รวม W01/W02/A23/T00: API 214 ผ่าน + queue integration เดิมข้าม 6, DB 107 และ Web 109 ผ่าน
