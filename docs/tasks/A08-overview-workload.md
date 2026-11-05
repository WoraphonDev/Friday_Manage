# A08 · Overview โปรเจกต์ และ Workload

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | — เริ่มได้เลย |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/overview/**` · `apps/api/test/overview.e2e.test.ts` |
| หน้าจอ | 1 (`design/canvas/Main.dc.html`) · 7 (`design/canvas/Members.dc.html`) · M6 (`design/canvas/MobileOverview.dc.html`) · N1 (`design/canvas/AdminConsole.dc.html`) |
| สเปก | 03-api › 2 หน้า 1 และ 7 · 03-api › 3.2 แถว `w/workload` · docs/decisions.md (Man-Day แบ่งเท่ากันต่อ Dev ตอนคิด Workload) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `GET p/overview`: ความคืบหน้า (ตาม `progress_method`), Health (on track / at risk / off track), KPI (งานทั้งหมด / เสร็จ / เลยกำหนด / MD), Milestone, Workload สัปดาห์นี้ต่อคน, Burn-up รายสัปดาห์ (แผน vs เสร็จ), Activity ล่าสุด 10 รายการ
- กติกา Health: เทียบ % MD ที่ควรเสร็จตามแผน ณ วันนี้ กับ % ที่เสร็จจริง · ต่างไม่เกิน 5% = on track · ไม่เกิน 15% = at risk · เกิน = off track · เขียนไว้ในคอมเมนต์และ "บันทึกผล" เพราะผู้ใช้ยังไม่ได้ยืนยัน
- `GET p/workload?from&to&unit=md|hour&group=week` ต่อคนต่อสัปดาห์: MD ที่ได้รับ (Man-Day ÷ จำนวน Dev กระจายตามวันทำการของงาน), capacity (`project_members` → `workspace_members`), หักวันลา (`leaves`), เกิน capacity
- `GET w/workload?from&to&team=` รวมทุกโปรเจกต์ (`ws.workload.view`)
- แยกการคำนวณไว้ใน `overview/workload.ts` (export) ให้ A09, A10 ใช้

## กติกาที่ต้องตรง

- Guest ที่เป็น Viewer: overview ตัดชื่อคนและ Bug ออก · workload → 403

## เสร็จเมื่อ

- [x] test: Workload ของงาน 2 Dev แบ่งครึ่ง, วันลาลด capacity, Health 3 ระดับ
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- Lead Dashboard (A09)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

### Endpoint ที่เพิ่ม

- `GET p/overview?scope=all|mine&moduleId=` (`project.view`, Guest ได้) ตอบ `project` (ข้อมูลการ์ดขวา + scope items), `progress`, `health`, `kpis`, `lists`, `doneDaily`, `burnup`, `modules`, `statusBreakdown`, `milestones`, `workloadThisWeek`, `activity` (10 รายการ), `counts` และ `lastActivityAt`
- `GET p/workload?from&to&unit=md|hour|count&group=day|week|month&moduleId=&position=` (`project.workload.view`) ตอบ `buckets`, `people[].cells[]` (`value`, `capacity`, `utilizationPct`, `over`, `leaveDays`, `issues[]` ที่ประกอบเป็นค่านั้น), `people[].total`, `team[]` (รวมทั้งทีม), `thisWeek` (กล่องสรุปบนหน้า 7: capacity, มอบหมายแล้ว, Utilization, คนที่เกิน), `withoutBa`, `unscheduled`
- `GET w/workload?from&to&unit&group&team=` (`ws.workload.view` = Owner / Admin ของ Workspace) ตอบรายคนต่อช่วง แยก `byProject` สำหรับกราฟซ้อน, `capacityHoursWeek`, `allocatedHoursWeek` + `overAllocated` ("แบ่งให้โปรเจกต์ X / Y ชม." ของ N1 v1.0.3), `overPeriods`
- ไม่ส่ง `from` / `to` = 8 สัปดาห์นับจากวันจันทร์ของสัปดาห์นี้ (ตามหน้า 7) · ขอได้ไม่เกิน 366 วันต่อครั้ง เกินหรือ `from > to` ตอบ 400
- `overview/workload.ts` export ให้ A09 / A10: `computeWorkload` (คำนวณล้วน ไม่แตะฐานข้อมูล), `dailyShare`, `plannedMdBy`, `buckets`, `weekOf`, `inUnit`, `utilization`, `loadWorkItems`, `loadLeaves`, `loadWorkspaceCalendar`, `projectWorkload`, `workspaceWorkload` · `overview/health.ts` export `projectHealth`, `healthLevel`, `HEALTH_THRESHOLDS`

### กติกา Health (ชั่วคราว รอผู้ใช้ยืนยัน)

- เทียบ % Man-Day ที่ควรเสร็จตามแผน ณ วันนี้ กับ % ที่เสร็จจริง จากงานระดับล่างสุดที่ไม่ใช่ Bug และมีทั้ง Man-Day และวันในแผน
- แผน: Man-Day ของงานกระจายเท่ากันตามวันทำการระหว่าง Plan Start–End (สูตรเดียวกับ Workload) · จริง: Done = 100% ไม่อย่างนั้นใช้ `progress_pct`
- ช้ากว่าแผนไม่เกิน 5 จุด = `on_track` · ไม่เกิน 15 จุด = `at_risk` · เกิน 15 = `off_track` · เร็วกว่าแผนถือเป็น on track · ไม่มีงานที่วัดได้ = on track · ค่าอยู่ใน `HEALTH_THRESHOLDS` และส่งใน `health.thresholds`
- ส่งเหตุผลประกอบตามข้อความบนหน้า 1: `behindPlan` (จำนวนงานที่ช้ากว่าแผน), `overdue.count` + `overdue.topAssignee` ("Overdue 7 งาน (Kaijeaw 4)"), `capacity.weeksNeeded` เทียบ `capacity.weeksLeft` ("ตาม capacity ต้องใช้ ≈ 29 สัปดาห์ แต่แผนมี ≈ 24 สัปดาห์")

### ต่างจากสเปก / ทำตามหน้าจอ

- หน้า 7 มี Day / Week / Month และ "วัดจาก: Man-Day · ชั่วโมง · จำนวนงาน" จึงรับ `group=day|week|month` และ `unit=md|hour|count` (สเปกเขียนแค่ `unit=md` และ `group=week`) · กรอง "ตำแหน่ง" และ "Module" ด้วย `position`, `moduleId` · 1 MD = 8 ชม. ตามคอมเมนต์ใน `project_members`
- หน้า 1 มีตัวเลือก "ทั้งโปรเจกต์ / งานของฉัน" และ Module จึงรับ `scope`, `moduleId` · KPI บนหน้าจอคือ Overdue / Due today / Later this week / Done in 7 days พร้อมเทียบสัปดาห์ก่อน ส่วนสเปกเขียน งานทั้งหมด / เสร็จ / เลยกำหนด / MD → ส่งครบทั้งสองชุดใน `kpis` และรายการงานของแต่ละ KPI (สูงสุด 10 รายการ) ใน `lists`
- กราฟ "งานที่เสร็จ · 7 วันล่าสุด" สลับ "Done รายวัน / Burn-up" → ส่ง `doneDaily` (7 วัน) และ `burnup` (รายสัปดาห์ จ.–อา., แผนสะสม vs เสร็จสะสม · สัปดาห์ที่ยังไม่ถึงตอบ `done: null` · หน่วย MD เมื่อ `progress_method = weighted` และจำนวนงานเมื่อ `count` · ยาวสุด 260 สัปดาห์)
- Status breakdown บนหน้าจอมีกลุ่ม "Backlog" แต่ Workflow มาตรฐานไม่มีสถานะนี้ → ตอบตามคอลัมน์ของบอร์ดมาตรฐาน (To do, In progress, Review, Done) และนับ Bug ในคอลัมน์ที่สถานะผูกไว้แบบเดียวกับ Kanban
- Milestone "งานที่ผูกไว้เสร็จ %" ใช้งานใน `milestone_issues` · ถ้าไม่ได้ผูกงานแต่มี Module ใช้ความคืบหน้าของ Module (หน้าจอ "Credit Line ครบตามแผน" = 39% เท่ากับ Module) · ไม่มีทั้งสองใช้ทั้งโปรเจกต์ · บอกที่มาใน `basis`
- หน้า M6 ใช้ `counts.openBugs` และ `counts.pendingDueRequests` · กล่อง "ความเสี่ยง" ของ M6 ไม่อยู่ในงานนี้ (A09 `insights/risks`)

### คำตัดสินที่เลือกเอง

- นับ Workload และ Man-Day เฉพาะงานระดับล่างสุด (Task ที่ไม่มี Sub-task หรือ Sub-task) เพราะ Estimate ของ Task ที่มี Sub-task = ผลรวม Sub-task (01-entities) · Bug ที่อยู่ใต้ Task ไม่ทำให้ Task หยุดเป็นงานระดับล่างสุด
- Workload กระจายตามแผนทุกสถานะ (รวมงานที่ Done แล้ว) ตามสูตรในสเปก · งานที่ช่วงแผนเป็นวันหยุดทั้งหมดนับไว้ที่วันทำการถัดไป · งานที่มี Dev แต่ไม่มีวันในแผนหรือ Man-Day นับใน `unscheduled` ("คำนวณไม่ได้")
- คนใน Workload ของโปรเจกต์ = คนที่เป็น Dev (assignee) ของงานอย่างน้อย 1 งานในโปรเจกต์และยังเป็นสมาชิก Workspace ที่ active · PM / BA ที่ไม่มีงานไม่อยู่ในกราฟ ให้ capacity ทีมตรงกับ "Dev 6 คน × 5 วันทำการ"
- capacity ต่อวันทำการ = ชั่วโมงต่อสัปดาห์ (`project_members` ก่อน แล้ว `workspace_members`) ÷ 8 ÷ จำนวนวันทำงานต่อสัปดาห์ · หักวันหยุดตามปฏิทินของโปรเจกต์ และวันลา (ครึ่งวัน = 0.5) · ยังไม่ใช้ `workspace_members.work_days` รายคน
- วันลานับทั้ง `pending` และ `approved` เพราะยังไม่มีขั้นอนุมัติวันลาในแอป (A20 สร้างเป็น pending)
- Workload รวมทุกโปรเจกต์ใช้ capacity ทั้งหมดของคน (`workspace_members`) กับปฏิทินของ Workspace · ไม่รวมโปรเจกต์ที่ลบหรือ Archive · กรองทีมแล้วแสดงสมาชิกทีมทุกคนแม้ยังไม่มีงาน · ไม่กรองทีมแสดงเฉพาะคนที่มีงาน
- ความคืบหน้าตาม `progress_method`: weighted ถ่วงด้วย Man-Day (Task ที่มี Sub-task ใช้ผลรวม Sub-task) · count นับจำนวนงาน · Health ใช้ Man-Day เสมอตามกติกาในงานนี้
- งานในแผน (ความคืบหน้า, MD, Burn-up, Module, Milestone, Health) ไม่รวม Bug · KPI, รายการ และ Status breakdown รวม Bug (ยกเว้น Guest)
- Guest ที่เป็น Viewer: ตัด Bug ออกจากทุกตัวเลข, รายการงานส่ง `canOpen` แทน `assignees`, เจ้าของโปรเจกต์และผู้กระทำใน Activity แสดงเป็น "ทีมพัฒนา" (ยกเว้นตัวเอง), ค่าเก่า/ใหม่ของฟิลด์คนเป็น null แบบเดียวกับ A01, `workloadThisWeek` และ `counts` เป็น null, ไม่มี `health.overdue.topAssignee` · `p/workload` และ `w/workload` ตอบ 403
- Activity ล่าสุดใช้รูปแบบเดียวกับ `GET i/activity` ของ A01 + `issue: { key, title }` · เมื่อกรอง `scope` / `moduleId` หรือเป็น Guest แสดงเฉพาะ Activity ของงานในชุดที่เห็น

### คำขอนอก lane

- RLS / `SYSTEM_DB`: Owner / Admin ของ Workspace ที่ยังไม่ได้ "เข้าร่วมในฐานะ Admin" มองไม่เห็นงานในโปรเจกต์ Private (RLS) → `w/workload` จึงไม่รวมภาระงานจากโปรเจกต์เหล่านั้น ทั้งที่ N1 ตั้งใจให้ "เห็นงานซ้อนข้ามโปรเจกต์" · ถ้าต้องการให้ครบ ต้องตัดสินว่าจะเพิ่มฟังก์ชัน SECURITY DEFINER ที่ตอบเฉพาะยอดรวม (T00) หรืออนุญาตใช้ `SYSTEM_DB` เฉพาะ endpoint นี้ (ขัดกับ AGENTS.md ตอนนี้)
- แคช Workload รวมทุกโปรเจกต์ใน Valkey ตาม 01-entities ถ้าช้า (A16) · ตอนนี้คำนวณสดทุกคำขอ

### คำถามที่ค้าง

- ยืนยันเกณฑ์ Health 5% / 15% และฐานที่ใช้ (Man-Day ระดับล่างสุด, ไม่รวม Bug)
- วันลาที่ยัง `pending` ควรลด capacity หรือไม่ (ตอนนี้ลด)
- Workload ควรตัดงานที่ Done ก่อนแผนออกจากสัปดาห์ที่เหลือหรือไม่ (ตอนนี้กระจายตามแผนเสมอ)

### ผลตรวจ

- `overview.e2e.test.ts` 10 tests: ตัวแบ่งช่วง, MD ของงาน 2 Dev แบ่งครึ่ง, วันหยุดและวันลาเต็มวัน/ครึ่งวันลด capacity, เกิน capacity, หน่วย hour / count / day, ไม่นับ MD ซ้ำของ Task ที่มี Sub-task และ Bug ใต้ Task, capacity ของโปรเจกต์ + กรองตำแหน่ง, 400 / 403, Workload รวมทุกโปรเจกต์ + ทีม + สิทธิ์, Health 3 ระดับรวมค่าขอบ 5 และ 15, KPI / รายการ / Burn-up / Module / Milestone / Activity / งานของฉัน / Module filter และการตัดข้อมูลของ Guest
- วันที่ใน test ตายตัว (Workload ใช้ ธ.ค. 2569, Health ใช้งานปี 2563 คู่ 2642) หรือคิดจาก `today()` เฉพาะ KPI ที่ขึ้นกับวันนี้ ไม่ขึ้นกับวันที่รัน
- `pnpm typecheck` ผ่าน · `pnpm test` ผ่าน: web 52, DB 105, API 109 tests (API มี 2 tests เดิมที่ skip) · ใช้ฐานทดสอบแยก `friday_a08`
