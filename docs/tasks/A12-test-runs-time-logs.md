# A12 · ผลทดสอบ, สร้าง Bug จากผลทดสอบ และบันทึกเวลา

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | — เริ่มได้เลย |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/qa/**` · `apps/api/test/qa.e2e.test.ts` |
| หน้าจอ | D (`design/canvas/SubtaskModal.dc.html`) · K2 (`design/canvas/BugDetail.dc.html`) · M4 (`design/canvas/MobileSubtask.dc.html`) |
| สเปก | 03-api › 3.7 แถว `i/test-runs`, `i/time-logs` · คำตัดสิน: Bug เป็นได้ทั้ง Task และ Sub-task |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `GET / POST i/test-runs` (เลขรอบเพิ่มเอง, ผล, passed / total, environment, commit) · ผลไม่ผ่าน → Event `test_run.failed`
- `POST i/test-runs/{id}/create-bug`: สร้าง Bug ผ่าน `IssuesService.create` กรอกขั้นตอน / หลักฐานจากผลทดสอบ, `found_in_test_run_id` · งานที่ทดสอบเป็นระดับ Task → Bug เป็น Sub-task ของงานนั้น · เป็น Sub-task → Bug อยู่ใต้งานแม่เดียวกัน
- `GET / POST / DELETE i/time-logs` เฉพาะโปรเจกต์ที่เปิด Time log (ปิด → 404 `time_log_disabled`) · ลบได้เฉพาะของตัวเอง

## กติกาที่ต้องตรง

- บันทึกผลทดสอบ: `issue.record_test` · บันทึกเวลา: `issue.time_log`

## เสร็จเมื่อ

- [x] test ครอบคลุมทุกข้อ
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

### Endpoint ที่เพิ่ม (`apps/api/src/qa/`) · ทุก route อยู่ใต้ `w/:ws/issues/:issueKey`

| Method | Path | สิทธิ์ | หมายเหตุ |
|---|---|---|---|
| GET | `test-runs` | ดูงานได้ | ใหม่ก่อน + `latest` · แต่ละรอบมี `tester`, `files[]` (หลักฐาน), `bugs[]` (Bug ที่สร้างจากรอบนี้) |
| POST | `test-runs` | `issue.record_test` (Admin / Member) | `{ result: passed\|failed\|blocked, passedCount?, totalCount?, environment?, commitSha?, note?, fileIds? }` · `passedCount` และ `totalCount` ต้องคู่กันและ passed ≤ total · เลขรอบเพิ่มเอง (ล็อกกันซ้ำ) · `fileIds` = ไฟล์ใน Files ของโปรเจกต์เดียวกันที่แนบเป็นหลักฐาน · Event `test_run.failed` เมื่อ `failed` (หลัง commit) · Viewer / Guest ไม่ได้ |
| POST | `test-runs/:id/create-bug` (และ `:create-bug`) | `issue.create` | ได้ 201 พร้อม Bug ทั้งก้อน + `foundInTestRun`, `attachedFiles` |
| GET | `time-logs` | ดูงานได้ | `items[]` (+`mine`), `totalMd`, `estimateMd`, `byUser[]` |
| POST | `time-logs` `{ md, date?, note? }` | `issue.time_log` | วันที่เริ่มต้น = วันนี้ (เวลาไทย) ล่วงหน้าไม่ได้ · `md` > 0 และ ≤ 3 · รวมต่อคนต่องานต่อวันไม่เกิน 3 MD (422 `time_log_limit`) |
| DELETE | `time-logs/:id` | เจ้าของบันทึก | ของคนอื่น (แม้ Admin) 403 |

โปรเจกต์ที่ปิด Time log (ค่าเริ่มต้น `time_log_enabled = false`) → ทั้งสาม method ตอบ 404 `time_log_disabled`

### `create-bug`

- สร้างผ่าน `IssuesService.create` จึงได้กติกา สิทธิ์ และ Event (`issue.created`, `bug.created`, `issue.assigned`) เดียวกับสร้างงานปกติ
- **ตำแหน่ง**: งานที่ทดสอบเป็น Task → Bug เป็น Sub-task ของ Task นั้น · งานที่ทดสอบเป็น Sub-task → Bug อยู่ใต้งานแม่เดียวกัน (ไม่ซ้อน 3 ชั้น)
- **ข้อมูลที่กรอกให้**: ชื่อ `[DP-20 รอบ 1] <ชื่องาน>` · รายละเอียดสรุปรอบ (ผ่าน/ไม่ผ่าน, ผ่าน N จาก M, Environment, Commit, ขั้นตอนจาก `note`) · `details.steps` / `foundInRun` / `testedIssue` / `commitSha` · ผู้รับผิดชอบเดิมของงานที่ทดสอบ · priority ตาม severity (critical → urgent, major → high, minor → medium) · `found_in_test_run_id` · หลักฐานของรอบ (ไฟล์เดียวกัน ไม่ทำสำเนา) แนบเป็นไฟล์ของ Bug
- สร้างได้เฉพาะรอบ `failed` / `blocked` (รอบที่ผ่าน → 409 `run_passed`) และสร้างหลาย Bug จากรอบเดียวได้
- Override ได้ใน body: `title`, `severity`, `priority`, `assigneeIds`, `steps`, `description`, `environment`

### คำตัดสินที่เลือกเอง

- **สิทธิ์บันทึกผลทดสอบ**: ใช้ `issue.record_test` ตามไฟล์งาน (03-api 3.7 เขียน `issue.edit`) · `issue.record_test` ตายตัวให้ Admin และ Member (Viewer ไม่มี)
- **Environment ของ Bug**: ประเภท Bug บังคับ Environment ถ้ารอบทดสอบไม่ระบุและ body ไม่ส่ง จะใช้ `sit` (ค่าที่ QA ใช้บ่อยสุด) แทนที่จะตอบ 400 เพื่อให้ปุ่ม "สร้าง Bug จากผลทดสอบ" ทำงานได้ทันที แก้ภายหลังได้
- ขีดจำกัด 3 MD ต่อวันต่อคนต่องานเป็นกติกาที่ผมกำหนดเอง (สเปกไม่ระบุ) เพื่อกันค่าผิดปกติ
- ผลทดสอบไม่มี endpoint แก้ / ลบ (สเปกไม่ระบุ · ผลทดสอบเป็นประวัติ) · บันทึกผลเขียน activity `test_run_recorded`

### คำขอนอก lane

- **A23**: Event `test_run.failed` ส่งผู้รับ Assignee อยู่แล้ว (รองรับไว้ใน `fanout.ts`) ไม่ต้องแก้
- **A03**: หน้ารายละเอียดงาน (`GET issues/{key}`) ยังไม่รวม `latestTest` และ `siblings` ตามหน้า D — เรียก `GET test-runs` แยกได้ ถ้าต้องการรวมในคำตอบเดียว ต้องให้ A03 เรียกจาก `QaService`
- **A08 / A09**: บันทึกเวลา (`time_logs`) ยังไม่ถูกใช้ใน Workload / รายงาน

### ผล test

`apps/api/test/qa.e2e.test.ts` 10 ข้อ: บันทึกผลทดสอบ (เลขรอบ, Event เฉพาะ failed, รายการ, activity, พร้อมกัน 4 รอบไม่ซ้ำ, ตรวจข้อมูล, สิทธิ์ Viewer / Guest, Archive, หลักฐาน) · `create-bug` (Task → Sub-task, Sub-task → ใต้แม่เดียวกัน, ผูก `found_in_test_run`, ผู้รับผิดชอบ, หลักฐานกลายเป็น evidence ที่ลบต้องยืนยัน, override, หลาย Bug, รอบที่ผ่าน 409, รอบของงานอื่น 404, สิทธิ์) · time-logs (ปิดอยู่ 404 ทุก method, บันทึก/รวม/ลบเฉพาะของตัวเอง, ตรวจข้อมูล, ขีดจำกัดรายวัน, Viewer / Guest) · `pnpm typecheck` ผ่าน · API ทั้งชุดผ่าน
