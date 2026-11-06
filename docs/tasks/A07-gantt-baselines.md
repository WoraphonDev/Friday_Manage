# A07 · Gantt, Baseline, การแก้ไขแผน และ Auto-schedule

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | — เริ่มได้เลย |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/gantt/**` · `apps/api/test/gantt.e2e.test.ts` |
| หน้าจอ | 5 (`design/canvas/Gantt.dc.html`) · L3 (`design/canvas/ImportExcel.dc.html`) |
| สเปก | 03-api › 3.6 แถว `p/baselines`, `p/plan-changes`, `p/schedule:preview` · 03-api › 2 หน้า 5 |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `GET p/gantt?from&to&baseline=` : WBS (Module › กลุ่มงาน › Task › Sub-task แบบ Timeline ใน `views/views.service.ts`) + Dependency + วันของ Baseline ที่เลือก + Critical path (FS + lag, นับวันทำการ) + slack ต่องาน
- `GET / POST p/baselines` (ตั้ง: `project.baseline`) สร้าง `baseline_items` ของทุกงาน version + 1
- `GET p/plan-changes?baseline=` (แท็บ "การแก้ไขแผน" ของ L3) และ `.xlsx` ไฮไลต์ช่องที่แก้ (exceljs)
- `POST p/schedule:preview` คืนรายการ `{ key, planStart, planEnd }` ที่ต้องเลื่อนตาม Dependency และปฏิทินวันทำการ โดยไม่บันทึก (ยืนยันด้วย `p/issues/bulk` ของ A03)

## กติกาที่ต้องตรง

- Critical path คิดเฉพาะงานที่ยังไม่เสร็จและมีวันที่
- Guest ไม่เห็น Gantt (403 `guest_view_limited`)

## เสร็จเมื่อ

- [x] test: Critical path ของงาน 4 งานที่มีทางแยก, preview เลื่อนงานตาม FS ข้ามวันหยุด, Baseline v2
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- Gantt PDF (ยังไม่วางเป็นงาน)

## บันทึกผล

### Endpoint ที่เพิ่ม (`apps/api/src/gantt/`) · ทุกข้อ Guest ได้ 403 `guest_view_limited`

| Method | Path | สิทธิ์ | หมายเหตุ |
|---|---|---|---|
| GET | `w/:ws/projects/:key/gantt?from&to&baseline=v1` | `project.view` | ผลของ `GET timeline` (Module › กลุ่มงาน › Task › Sub-task, Sprint, Milestone, `unscheduled`) เติมต่อแถว: `critical`, `slackDays` (วันทำการ · null = ไม่อยู่ในการคำนวณ), และเมื่อเลือก `baseline`: `baseline {start,end}` กับ `slipDays` (วันปฏิทิน · บวก = ช้ากว่า Baseline) · เพิ่ม `dependencies[] {from,to,type,lagDays,critical}`, `criticalPath {keys,startDate,endDate}`, `baselines[]`, `baseline`, `ignoredDependencies` |
| GET | `.../baselines` | `project.view` | เรียง version ใหม่ก่อน พร้อม `itemCount`, `createdBy` |
| POST | `.../baselines` `{ name? }` | `project.baseline` | version + 1 · เก็บ `baseline_items` ของทุกงาน (รวมที่ยังไม่มีวัน) พร้อม Man-Day และ Dev · ล็อกต่อโปรเจกต์กันเลขซ้ำ · Audit `baseline.created` |
| GET | `.../plan-changes?baseline=&limit=&before=` | `project.view` | ใหม่ก่อน · แบ่งหน้าด้วย `before` → `nextCursor` · คืน `fieldLabel`, `oldValue`, `newValue`, `reason`, `impact`, `source`, `baselineVersion`, `changedBy` |
| GET | `.../plan-changes.xlsx?baseline=` | `project.view` | exceljs · ค่าเดิมไฮไลต์แดงอ่อน ค่าใหม่ไฮไลต์เหลือง · ชื่อไฟล์ `<KEY>-plan-changes[-vN].xlsx` |
| POST | `.../schedule/preview` (และ `schedule:preview`) | `issue.edit` | ไม่บันทึกอะไร · คืน `items[] {key,title,planStart,planEnd,previousStart,previousEnd,shiftDays,because[]}`, `summary`, `projectEnd {before,after}`, `warnings[]` · ยืนยันด้วย `PATCH issues/:key` ทีละงาน (`issues/bulk` ยังรับวันต่างกันต่องานไม่ได้ ดู "คำขอนอก lane") |

### วิธีคำนวณ (`cpm.ts`)

- แกนเวลาเป็น **วันทำการ** ตาม `WorkCalendar` ของโปรเจกต์ (ข้ามเสาร์–อาทิตย์ วันหยุดของ Workspace และของโปรเจกต์) · วันเริ่มที่ตรงวันหยุดถือเป็นวันทำการถัดไป วันจบที่ตรงวันหยุดถือเป็นวันทำการก่อนหน้า
- Dependency ชนิด FS / SS / FF / SF + lag (วันทำการ ติดลบได้)
- **Critical path**: CPM โดยใช้วันตามแผนเป็น Early dates แล้วคิด Late dates ย้อนจากวันจบของโครงข่าย · `slack = Late finish − Early finish` · วิกฤต = `slack ≤ 0` และอยู่ในโครงข่าย Dependency (งานเดี่ยวที่ไม่มี Dependency ไม่นับเป็นเส้นทาง) · เฉพาะงานที่ยังไม่เสร็จและมีวัน Start/End · Dependency วิกฤต = ปลายทั้งสองวิกฤตและไม่มีช่องว่าง
- **Auto-schedule**: เลื่อนเฉพาะงานที่ละเมิด Dependency ไปข้างหลัง (ไม่ดึงให้เร็วขึ้น) คงจำนวนวันทำการเท่าเดิม เลื่อนต่อเป็นทอดตามลำดับพึ่งพา · งานที่เสร็จแล้วเป็นตัวยึด · เลย Go-live → `warnings` `golive_exceeded`
- Dependency วนเป็นวง → 422 `dependency_cycle` พร้อม `details.keys` (ปกติ A02 กันไว้แล้ว นี่เป็นด่านสุดท้ายถ้าข้อมูลหลุดมา)

### คำตัดสินที่เลือกเอง

- **ใช้ `project.baseline` ตั้ง Baseline** ตามไฟล์งานและ 04-permissions (03-api 3.6 เขียน `project.settings`) · ถ้าจะให้ตรงสเปกให้แก้ 03-api ใน D99
- **โหนดคำนวณ = งานที่ไม่มี Sub-task เท่านั้น** (งานแม่เป็นตัวสรุป วันของงานแม่ตามงานย่อย) · Dependency ที่ปลายใดปลายหนึ่งเป็นงานแม่ **ถูกข้าม** และบอกจำนวนใน `ignoredDependencies` / warning `summary_dependency_ignored` · ถ้าหน้า Gantt ต้องการให้ Dependency ระหว่างงานแม่มีผล ต้องตัดสินว่าจะส่งต่อไปที่งานย่อยแรก/ตัวสุดท้ายอย่างไร
- `GET gantt` ไม่ใส่ `baseline` = ไม่เทียบ (ไม่เลือก Baseline ล่าสุดให้เอง)
- Gantt เรียก `ViewsService.timeline` ซ้ำเพื่อให้ WBS เหมือน Timeline ทุกประการ (ไม่ copy โค้ด) จึงใช้ 2 ธุรกรรมต่อคำขอ
- ไม่ส่ง Event `baseline.created` เพราะ 03-api ไม่มีในรายการ · เขียน Audit แทน

### คำขอนอก lane

- **A03 (สำคัญ)**: `POST issues/bulk` ใช้ยืนยันผลของ `schedule:preview` ไม่ได้ในตอนนี้ เพราะ `set` รับ `planEnd` ค่าเดียวให้ทุก `keys` และไม่รับ `planStart` ขณะที่ preview ให้วัน Start/End ต่างกันต่องาน · ต้องเพิ่มรูปแบบ `{ items: [{ key, planStart, planEnd }], planChangeReason? }` (หรือให้หน้าเว็บ PATCH ทีละงาน) และเขียน `plan_change` เมื่อมี Baseline · ระหว่างนี้ W08 ยืนยันด้วย `PATCH issues/:key` ทีละงานได้
- **D99**: 03-api 3.6 แถว `p/baselines` (สิทธิ์ตั้ง), `p/schedule:preview` (ไม่มีตัวหนังสือ `body`), และเพิ่ม `ignoredDependencies` ใน response ของ `p/gantt`
- **W08 / W14**: ใช้ฟิลด์ `critical`, `slackDays`, `baseline`, `slipDays`, `dependencies[].critical` ได้เลย

### ผล test

`apps/api/test/gantt.e2e.test.ts` 16 ข้อ: Critical path งาน 4 งานที่มีทางแยก (A→B→D วิกฤต, C slack 2) · ข้ามงานเสร็จ/งานไม่มีวัน · นับวันทำการข้ามวันหยุด 7 / 10 ธ.ค. พร้อม lag · วงกลม 422 · Dependency งานแม่ · Guest/Viewer/from-to · Baseline v1 → v2, เทียบ `slipDays`, ตั้งพร้อมกันได้ v1/v2 ไม่ซ้ำ, สิทธิ์ · plan-changes กรอง/แบ่งหน้า และ .xlsx (อ่านไฟล์กลับมาตรวจสีไฮไลต์) · preview เลื่อนตาม FS ข้ามวันหยุดเป็นทอดโดยไม่บันทึก, SS/FF + lag, ไม่ดึงงานให้เร็วขึ้น, ตัวยึดงานเสร็จ, Go-live warning, สิทธิ์ · unit ของ `Axis`/SF/lag ติดลบ · `pnpm typecheck` ผ่าน
