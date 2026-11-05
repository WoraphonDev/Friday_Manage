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

- [ ] test: Critical path ของงาน 4 งานที่มีทางแยก, preview เลื่อนงานตาม FS ข้ามวันหยุด, Baseline v2
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- Gantt PDF (ยังไม่วางเป็นงาน)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
