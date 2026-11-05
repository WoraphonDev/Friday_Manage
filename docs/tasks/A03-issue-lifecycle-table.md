# A03 · วงจรชีวิตงาน: ลบ / กู้คืน, Bulk, Reopen, Assignees, ตัวกรอง Table, form-options

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | — เริ่มได้เลย |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/issues/**` · `apps/api/test/issues.e2e.test.ts` · `apps/api/src/issues/**` (รวม `issues.service.ts` ซึ่งงานอื่นเรียกใช้: method เดิมห้ามเปลี่ยน signature) |
| หน้าจอ | 2 (`design/canvas/Table.dc.html`) · B (`design/canvas/TaskCreate.dc.html`) · K1 (`design/canvas/IssueCreate.dc.html`) · K2 (`design/canvas/BugDetail.dc.html`) · P3 (`design/canvas/ConfirmDialogs.dc.html`) · M1 (`design/canvas/States.dc.html`) |
| สเปก | 03-api › 3.7 (DELETE, `:restore`, `delete-impact`, `:reopen`, `assignees`, `p/issues/bulk`, `p/issues` ตัวกรองหน้า Table, `p/form-options`) · 03-api › กติกาการเปลี่ยน Due (ใช้กับ bulk) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `DELETE i/` soft delete พร้อม Sub-task · `POST i/restore` ภายใน 30 วัน · `GET i/` ของงานที่ลบตอบ 410 พร้อม `deletedBy`, `deletedAt`, `restorableUntil` · `GET i/delete-impact` (Sub-task, ไฟล์หลักฐาน, Dependency)
- `POST i/reopen` (Bug): `reopen_count + 1`, กลับสถานะแรกของ Workflow · Event `bug.reopened`
- `PUT i/assignees` (ใช้ If-Match) · Event `issue.assigned`
- `POST p/issues/bulk` `{ keys, set: { planEnd?, moduleId?, sprintId?, assigneeIds? } }` หรือ `{ keys, delete: true, confirmText }` · ตอบผลรายงาน `{ key, ok, error? }` · ใช้กติกา Due / Baseline เดียวกับ PATCH ทีละงาน
- `GET p/issues`: ตัวกรองทั้งหมดของหน้า Table (module, phase, sprint=current|id|none, status, type, assignee, ba, priority, overdue, q) · sort · `view=table` คืนค่ารวม MD / ความคืบหน้าต่อ Module และกลุ่มงาน · `fields=`
- `GET p/form-options` (หน้า B / K1): Module, กลุ่มงาน, Sprint, สมาชิก (คน), Size → MD, Label, ประเภทงานพร้อมฟิลด์บังคับ
- ตรวจ `workflow_rules` ที่เปิดอยู่ตอน PATCH / move (ruleType ที่ A05 กำหนด) → 422

## กติกาที่ต้องตรง

- method public เดิมของ `IssuesService` (`loadIssue`, `findByKey`, `dto`, `dtos`, `create`, `patch`, `move`) ใช้โดยงานอื่น: เพิ่มพารามิเตอร์แบบ optional ได้ ห้ามเปลี่ยนความหมาย
- test เดิมใน `api.e2e.test.ts` ต้องผ่านโดยไม่แก้

## เสร็จเมื่อ

- [ ] test ใหม่ใน `issues.e2e.test.ts` ครอบคลุมทุกข้อ รวม bulk ที่บางงานโดน `due_change_requires_approval`
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- Import โหมดอัปเดต (A15)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
