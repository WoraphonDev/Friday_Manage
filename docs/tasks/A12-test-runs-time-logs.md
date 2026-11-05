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

- [ ] test ครอบคลุมทุกข้อ
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
