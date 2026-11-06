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

- [x] test ใหม่ใน `issues.e2e.test.ts` ครอบคลุมทุกข้อ รวม bulk ที่บางงานโดน `due_change_requires_approval`
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- Import โหมดอัปเดต (A15)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

- เพิ่ม `DELETE issues/{key}`, `POST issues/{key}/restore`, `GET issues/{key}/delete-impact`, `POST issues/{key}/reopen`, `PUT issues/{key}/assignees`, `POST projects/{key}/issues/bulk` และ `GET projects/{key}/form-options` โดยใช้ path แบบเดียวกับ endpoint เดิม (`/move`, `/approve`)
- ลบงานแม่พร้อมลูกที่ยังอยู่, กู้คืนได้ 30 วัน และคืนเฉพาะลูกที่ถูกลบไปพร้อมแม่ครั้งนั้น ไม่คืนลูกที่ถูกลบไว้ก่อน · เก็บไฟล์/คอมเมนต์/Dependency ไว้เพื่อกู้คืน · impact รวมไฟล์ที่แนบกับงาน, ผลทดสอบ และคอมเมนต์ โดยนับไฟล์ไม่ซ้ำ · ลบ/กู้คืนบันทึก activity และ Audit; ส่ง Event หลัง commit
- ตาราง `issues` ไม่มี `deleted_by`: ใช้ผู้กระทำใน activity `deleted` ล่าสุดเป็น `deletedBy` (person DTO) โดยไม่เปลี่ยน schema · Guest Viewer ได้เพียง `{ displayName: "ทีมพัฒนา" }`; ตรวจ visibility และซ่อน Bug ก่อนตอบ 410
- Table รองรับ `module`, `phase`, `sprint=current|none|<id>`, `status=<category|id>` (หลายค่าคั่น comma), `type`, `assignee`, `ba`, `priority`, `overdue`, `q`, `level`, `fields` และ `sort=<field>|-<field>|<field>:asc|desc` · `moduleId/phaseId/sprintId` เป็น alias · cursor ของ sort ปกติยังเป็นเลขเดิม; sort อื่นเป็น opaque cursor ที่มี tie-break ด้วยเลขงานและ null อยู่ท้าย
- `view=table` ส่ง `summary` และ `modules[].phases[]` พร้อม MD/จำนวนงาน/ความคืบหน้า ตามผลกรองทั้งหมดก่อนแบ่งหน้า · MD ไม่นับลูกซ้ำแม่; progress ของแม่คิดจากลูกที่ยังอยู่ทั้งหมด แม้ลูกบางงานไม่ตรงตัวกรอง · เพิ่ม assignees/BA เป็น person DTO และ labels
- form-options รวม Module/Phase/Sprint, สมาชิกโปรเจกต์ที่ active, sizeMdMap (Project override Workspace), Label และประเภทงานที่เปิดพร้อม requiredFields/statuses
- Bulk ใช้ PATCH/ลบเดิมต่อรายงานในธุรกรรมอิสระ คืน `{ results: [{ key, ok, error? }] }` · เหตุผลหลัง Baseline อยู่ใน `set.planChangeReason`; error บอก status/code/message/details · bulk delete ต้องพิมพ์ `ลบ N งาน` ตาม P3 และไม่นับ key ซ้ำ · การลบในงานนี้ใช้ default cascade ตามข้อกำหนด A03; ตัวเลือกแปลงลูกเป็น Task เดี่ยวใน P3 ยังไม่อยู่ใน API นี้
- Reopen ใช้ได้เฉพาะ Bug ที่พ้นสถานะแรกแล้ว (รวม Fixed/Closed), เพิ่ม reopenCount, ล้าง Actual End/completedAt และส่ง `bug.reopened`; PUT Assignees ใช้ PATCH ร่วมกันเพื่อบังคับ If-Match/สิทธิ์/Baseline และส่ง `issue.assigned` ให้ตรงกัน
- ข้อตกลงให้ A05: ยังไม่มี `project-structure/rules.ts` ใน main จึงประกาศชื่อใน `issues/rules.ts`: `subtasks_done`, `reviewer_required`, `reviewer_only_done`, `fix_reference_required`, `tester_or_reporter_only_verified`, `wip_warning`, `reopen_on_failed_test`, `critical_auto_start` · สองตัวท้ายเป็นกฎตอบเหตุการณ์ของ QA/Automation ไม่มีเงื่อนไขบล็อก transition · config รองรับ `fromStatusId/toStatusId` · A05 สามารถ import/re-export contract นี้จาก lane ของตัวเอง; ไม่แก้ไฟล์นอก lane
- ตรวจ enabled rules ใน PATCH/move เป็น 422 พร้อม ruleId/ruleType; กฎที่ไม่รู้จักไม่ปล่อยข้ามเงียบ · โปรเจกต์เดิมที่ยังไม่มีแถวกฎยังคงพฤติกรรม Kanban เรื่อง Sub-task/WIP เดิม; เมื่อมีแถว disabled จะปิดกฎนั้นจริง
- รักษา signature/ความหมาย public methods ของ IssuesService เดิม และไม่แก้ test เดิม · ทดสอบใหม่ `issues.e2e.test.ts` เริ่มจาก startApp + seedTeam ครบ 19 กรณี (รวม Due partial failure, Baseline, Guest, cascade/expiry, workflow enabled/disabled และ cursor)
- ตรวจผ่าน: `pnpm typecheck`, `pnpm test` ทั้ง workspace: DB 105, API 73 (ใหม่ 19), Web 31 รวม 209 ผ่าน; มี opt-in test เดิม 2 ข้อที่ skipped ตาม environment เดิม · ทดสอบด้วยฐาน `friday_a03` แยกจากงานอื่น

### แก้ต่อหลัง A06: ปิดช่องย้ายงานเข้า Sprint ที่จบแล้ว

- แก้จุดค้างจาก A06 / PR #18: create, PATCH, move และ bulk (ผ่าน PATCH เดิม) ปฏิเสธ Sprint ปลายทางที่ completed ด้วย `422 sprint_completed` พร้อม `details.sprintId`; ตรวจ reference ข้ามโปรเจกต์/Workspace แบบเดิมและไม่เปลี่ยน signature ของ public methods
- ล็อกแถวโปรเจกต์ร่วมกับ Sprint complete ก่อนตรวจ Sprint/อ่าน version เดิม: create ล็อกก่อนอ่านแม่และจองเลขงาน เพื่อไม่ตรวจ Sprint ก่อนรอ complete หรือจับ lock แม่สลับกับโปรเจกต์; PATCH/move จับ lock นี้เฉพาะเมื่อส่ง sprintId (รวม null) · Bulk ใช้ transaction ต่อรายงานเดิม จึงยังรายงานความล้มเหลวแยกงานได้
- หลังรอ complete จะอ่านแผน/แม่/version ใหม่: PATCH ที่ If-Match ล้าสมัยตอบ 409 ตามเดิม, move ที่ไม่ส่ง If-Match ใช้ version ปัจจุบัน, Sub-task ที่สร้างหลังแม่ถูกย้ายออกจะสืบทอด Sprint ใหม่ · ไม่เพิ่มลูกเข้าแม่ที่ยังอยู่ completed แม้ส่ง sprintId อื่นมาเอง
- ยังแก้รายละเอียดงานเดิมใน completed หรือส่ง sprintId เดิมแบบไม่ย้ายได้ และย้ายออกไป planning/active/Backlog ได้; ไม่สร้าง/เพิ่มงานใหม่เข้า completed
- เพิ่ม regression 9 เคสใน issues.e2e.test.ts (รวมของเดิม 28): ครบ create/PATCH/move/bulk, rollback และไม่ส่ง Event เมื่อถูกปฏิเสธ, งานประวัติ, สร้างลูกและ If-Match · ทดสอบคำขอแข่งกับ API complete จริง โดยใช้ connection แยกถือ project lock แล้วรอหลักฐานจาก pg_blocking_pids (รวม soft blocker chain) ให้ complete ต่อคิวก่อนคำขอเปลี่ยนแผน โดยไม่ใช้ sleep จัดลำดับ
- ยืนยัน regression กับโค้ดเดิม: 2 เคส guard ล้มเพราะ API ตอบ 201 แทน 422; เมื่อนำโค้ดแก้กลับมา 28 เคสผ่าน · ตรวจเต็ม `pnpm typecheck`, `pnpm test` และ API build ผ่าน: Web 109, DB 107, API 223 ผ่าน + queue integration เดิมข้าม 6 · ใช้ฐานสมมติ friday_a03_sprint แยกจากงานอื่น
