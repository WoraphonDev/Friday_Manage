# A09 · Lead Dashboard และ Reports

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | A08 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/reports/**` · `apps/api/test/reports.e2e.test.ts` |
| หน้าจอ | O1 (`design/canvas/LeadDashboard.dc.html`) · O2 (`design/canvas/Reports.dc.html`) |
| สเปก | 03-api › 3.9 แถว insights, reports |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `GET p/insights/risks`: เลยกำหนด, ใกล้ครบกำหนดแต่ความคืบหน้าต่ำ, คน capacity เกิน (ใช้ `overview/workload.ts`), งานที่ติด Dependency, คำขอเลื่อน Due ที่รอ
- `GET p/insights/modules`: ความคืบหน้า, วันจบที่คาด (จากอัตราเสร็จจริง) เทียบ Milestone / Go-live ของ Module
- `GET p/reports/weekly?week=` · `module-forecast` · `traceability` (FR / Screen → งาน → ผลทดสอบล่าสุด)

## กติกาที่ต้องตรง

- Guest → 403

## เสร็จเมื่อ

- [x] test ครอบคลุมทุก endpoint ด้วยข้อมูลสมมติที่รู้คำตอบล่วงหน้า
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- ส่งรายงานตามรอบ (A25)

## บันทึกผล

### Endpoint ที่เพิ่ม (`apps/api/src/reports/`) · Guest → 403 `guest_view_limited`

| Method | Path | สิทธิ์ | หมายเหตุ |
|---|---|---|---|
| GET | `w/:ws/projects/:key/insights/risks` | `project.workload.view` | ความเสี่ยงของแผน เรียง high → medium → low |
| GET | `.../insights/modules` | `project.workload.view` | ความคืบหน้าราย Module + วันจบที่คาด + สรุปทั้งโปรเจกต์ |
| GET | `.../reports/weekly?week=YYYY-MM-DD` | `project.view` | `week` = วันใดก็ได้ในสัปดาห์ (ค่าเริ่มต้น สัปดาห์นี้) · สัปดาห์ที่ยังไม่จบ `draft: true` |
| GET | `.../reports/module-forecast?weeks=8` | `project.view` | `insights/modules` + Plan vs Actual Man-Day รายสัปดาห์ (ทั้งโปรเจกต์และราย Module) |
| GET | `.../reports/traceability?kind=&result=` | `project.view` | FR / NFR และ Screen → งาน → ผลทดสอบล่าสุด |

> หมายเหตุสิทธิ์: `project.workload.view` ตายตัวให้ทุก Role ในโปรเจกต์ (Admin, Member, Viewer) ตาม `permissions.ts` ต่างจากที่สเปกบางข้อเขียนไว้ว่า Admin เท่านั้น — ที่ถูกตัดคือ Guest Viewer

### `insights/risks` · `items[]` (`kind`, `severity`, `title`, `detail`, `count`, `issueKeys`, `people?`)

| kind | เงื่อนไข | high เมื่อ |
|---|---|---|
| `overdue` | งานระดับล่างสุดที่ยังไม่เสร็จและเลยกำหนด | เก่าสุดเลย ≥ 7 วัน หรือ ≥ 5 งาน |
| `due_soon_low_progress` | ครบกำหนดภายใน 7 วัน และคืบหน้า < 50% | มีงานที่ครบภายใน 2 วันและคืบหน้า < 25% |
| `capacity_over` | Dev ที่ Man-Day สัปดาห์นี้เกิน capacity (ใช้ `projectWorkload` ของ A08 รวมวันลา/วันหยุด) | ≥ 200% |
| `blocked` | งานที่ควรเริ่มแล้ว (หรือ Predecessor เลยกำหนด) แต่ Predecessor ยังไม่เสร็จ | Predecessor เลย ≥ 7 วัน |
| `pending_due_requests` | คำขอเลื่อน Due ที่ยังรอ | รอ ≥ 3 วัน |

### `insights/modules` · `modules[]` และ `summary`

- ต่อ Module: `taskCount`, `doneCount`, `totalMd`, `doneMd`, `remainingMd`, `progressPct` (ถ่วงด้วย Man-Day, ไม่มี Man-Day ใช้จำนวนงาน), `overdue`, `planStart`, `plannedEnd`, `milestone` (ถัดไป ไม่มีใช้ล่าสุด), `targetDate` (Milestone ไม่มีใช้วันจบตามแผน), `velocityMdPerWeek`, `forecastEnd`, `forecastReason` (`no_velocity` · `no_estimate`), `slipDays` (บวก = ช้ากว่าเป้า), `status` (`done` · `on_track` ≤0 · `at_risk` ≤7 · `off_track` · `no_forecast`)
- **วันจบที่คาด** = วันทำการที่ N นับจากวันนี้ เมื่อ N = ⌈เหลือ MD ÷ อัตราเสร็จจริง⌉ และอัตราเสร็จจริง = Man-Day ของงานที่เสร็จใน 28 วันล่าสุด ÷ วันทำการในช่วงนั้น (ข้ามวันหยุดตามปฏิทินโปรเจกต์)
- `summary`: `capacityMdPerWeek` (ผลรวม capacity ของคนที่ยังมีงานค้าง ÷ 8 ชม.), `requiredWeeks` (เหลือ MD ÷ capacity), `weeksToGoLive`, `gapWeeks` (บวก = ต้องใช้เวลามากกว่าที่เหลือ → ตรงกับ KPI "ต้องใช้จริงตาม capacity ≈ N สัปดาห์" ของ Canvas O1), `status` เทียบ Go-live

### `reports/weekly`

`week {start,end,label,draft,asOf}`, `status` (Health จาก `overview/health.ts`), `totals`, `thisWeek` (`done {count, md, keys}`, `inProgress`, `inReview` = สถานะชื่อ Review, `overdue {count, byAssignee}`, `newBugs`, `fixedBugs`), `nextWeek` (`starting {count, md, byModule}`, `holidays`, `sprintEvents`), `risks` (5 อันดับแรกจาก `insights/risks`), `needsHelp.unassigned` และ `text` ข้อความล้วนภาษาไทยสำหรับ "คัดลอก / ส่ง LINE · อีเมล" · นับ Task / Sub-task ระดับล่างสุดที่ไม่ใช่ Bug เป็น "งาน"

### `reports/traceability`

ผลต่อ FR / NFR / Screen: `uncovered` (ไม่มีงานอ้างอิง) · `untested` (มีงานแต่ไม่มีผลทดสอบ) · `partial` (บางงานผ่าน บางงานยังไม่ทดสอบ) · `passed` · `failed` (งานใดงานหนึ่งรอบล่าสุดไม่ผ่าน) · `blocked` · ผลทดสอบของแต่ละงานใช้รอบ (`run_no`) ล่าสุด · `summary.issuesWithoutRequirement` = งานที่ไม่มี FR อ้างอิง

### คำตัดสินที่เลือกเอง

- วันนี้ใช้ `today()` (เวลาไทย) · เกณฑ์ high / medium และเกณฑ์สถานะ Module (≤ 0 / ≤ 7 วัน) เป็นค่าที่ผมกำหนดเอง สเปกและ Canvas ไม่ระบุตัวเลข
- อัตราเสร็จจริงใช้หน้าต่าง 28 วันคงที่ (ไม่ใช่ค่าเฉลี่ยตั้งแต่เริ่มโปรเจกต์) เพื่อสะท้อนความเร็วล่าสุด · ไม่มีงานเสร็จใน 28 วัน → ไม่คาดวันจบ แทนที่จะแสดงค่าเดา
- `needsHelp` มีเฉพาะ "งานใกล้เริ่มแต่ไม่มีผู้รับผิดชอบ" เพราะ Canvas O2 หัวข้อ 4 ("ยืนยัน BA ของงาน …") เป็นข้อความที่ PM พิมพ์เอง ไม่ได้คำนวณ
- `send` / ตั้งเวลารายงาน (`weekly:send`, `report-schedule`) เป็นของ A25 ตามไฟล์งาน

### คำขอนอก lane

- **A25** (`channels/project-notify.service.ts`): ตัวเลขใน `sendReport` ยังคิดเองจากตาราง `issues` ควรเปลี่ยนไปใช้ `ReportsService.weekly().text` (โมดูล `ReportsModule` export `ReportsService` / `InsightsService` ไว้แล้ว) เพื่อให้รายงานที่ส่งกับหน้า Reports ตรงกัน
- **W15**: ใช้ `risks`, `modules`, `weekly` (`text` ไว้ปุ่ม "คัดลอกข้อความ"), `module-forecast`, `traceability` · Export PDF / Actual-จำลอง ฝั่งหน้าเว็บ

### ผล test

`apps/api/test/reports.e2e.test.ts` 11 ข้อ (จำลองวันที่ พ. 2 ธ.ค. 2569 ด้วย fixture 7 งาน + 1 Bug ที่รู้คำตอบล่วงหน้า): ความเสี่ยงครบ 5 แบบและลำดับ · ความคืบหน้าถ่วง Man-Day (33% / 11%), อัตราเสร็จ 2.5 / 0.5 MD ต่อสัปดาห์, วันจบที่คาดข้ามวันหยุด, Milestone, สรุปทั้งโปรเจกต์ (capacity 10 MD/สัปดาห์, ต้องใช้ 3.6 สัปดาห์), no_velocity และ done · รายงานรายสัปดาห์ (สัปดาห์นี้ร่าง / ย้อนหลัง / ข้อความ) · Plan vs Actual รายสัปดาห์ · Traceability (ทั้ง 6 ผลและรอบทดสอบล่าสุด, Screen, ตัวกรอง) · Guest · `pnpm typecheck` ผ่าน · API ทั้งชุด 392 ผ่าน
