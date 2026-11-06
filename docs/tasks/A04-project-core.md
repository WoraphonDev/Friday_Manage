# A04 · ข้อมูลโปรเจกต์, สมาชิกโปรเจกต์, Archive / โอน / ลบ, Template

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | T00 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/projects/**` · `apps/api/test/projects.e2e.test.ts` · `apps/api/src/projects/**` (รวม `permissions.ts`, `calendar.ts`, `projects.service.ts` ที่งานอื่นใช้: signature เดิมห้ามเปลี่ยน) |
| หน้าจอ | L2 (`design/canvas/ProjectSettings.dc.html`) · A (`design/canvas/NewProject.dc.html`) · 7 (`design/canvas/Members.dc.html`) · M1 (`design/canvas/States.dc.html`) · P3 (`design/canvas/ConfirmDialogs.dc.html`) |
| สเปก | 03-api › 3.4 และ 3.5 แถว `p/members` · 04-permissions › 3, 6 |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `PATCH p/` (ชื่อ, ลูกค้า, วันที่, visibility, Size → MD ของโปรเจกต์, Key) · เปลี่ยน Key → เก็บ `project_key_aliases` · Key เก่าตอบ 301 `project_moved` พร้อม `details.key`
- `GET / POST / PATCH / DELETE p/members` (Role, ตำแหน่ง, capacity) · ลบคนที่มีงานค้างต้องส่ง `reassignTo`
- `POST p/archive` · `/restore` (Archive = อ่านอย่างเดียว: ตัดสิทธิ์เขียนใน `projectAccess`) · `POST p/transfer` (Project Owner) · `DELETE p/` (`confirmKey`, soft delete 30 วัน) · `GET p/delete-impact`
- `POST w/projects` รับ `templateId` · `POST w/projects/sample` (ข้อมูลสมมติเท่านั้น) · CRUD template อยู่ใน A18

## กติกาที่ต้องตรง

- ทุก endpoint ที่ใช้ `ProjectsService.load` ต้องได้ 301 สำหรับ Key เก่าโดยไม่ต้องแก้ lane อื่น

## เสร็จเมื่อ

- [x] test ครอบคลุมทุกข้อ
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

- เพิ่ม `PATCH p/` (+ `If-Match`, ไม่ส่งตอบ 428, version ไม่ตรงตอบ 409 พร้อม `details.latest`) · แก้ได้: ชื่อ, Key, ลูกค้า, คำอธิบาย, สี, icon, วันเริ่ม / Go-live, timezone, visibility, ความยาว Sprint, หน่วยประมาณงาน, วิธีคิดความคืบหน้า, `sizeMdMap` (Size → MD, `null` = ใช้ของ Workspace), `holidayCalendarId`, `workStart` / `workEnd`, `timeLogEnabled` · `GET p/` ตอบ `ETag` และ DTO มี `archivedAt`, `templateId`, `sizeMdMap`, `holidayCalendarId`, `workStart`, `workEnd`, `icon` เพิ่ม · เขียน Audit `project.updated` และ `project.key_changed`
- เปลี่ยน Key: เก็บ Key เดิมใน `project_key_aliases` · `ProjectsService.load` ตอบ `301 project_moved` พร้อม `details: { key, oldKey }` จึงครอบทุก endpoint ที่โหลดผ่าน `load` (รวม `issues/OLD-5`, board, comments) โดยไม่แก้ lane อื่น · เปลี่ยนกลับเป็น Key เก่าของตัวเองได้ (ลบ alias นั้น) · Key เก่ายังถูกจอง โปรเจกต์อื่นใช้ไม่ได้
- เพิ่ม `GET / POST p/members` และ `PATCH / DELETE p/members/{userId}` (lane ของ A04 ใน `project-members.service.ts`) · รายชื่อเรียง Owner ก่อน แล้วตาม Role และชื่อ · แต่ละคนมี `role`, `isOwner`, `isGuest`, `position`, `capacityHoursWeek`, `capacityMdWeek` (8 ชม. = 1 MD), `openIssues`, `overdueIssues`, `openMd` (MD แบ่งเท่ากันตามจำนวน Dev) · ส่ง `member.joined` หลัง commit เมื่อเพิ่มคน · Audit หมวด perm ทุกการเพิ่ม / เปลี่ยน Role / นำออก
- `DELETE p/members/{userId}` ที่มีงานค้างโดยไม่ส่ง `reassignTo` ตอบ `409 member_has_open_issues` พร้อม `openIssues`, `openSubtasks`, `openMd` สำหรับ Dialog P3 · `reassignTo: <userId>` โอนให้คนนั้น · `reassignTo: null` = ไม่ระบุผู้รับผิดชอบ · โอนเฉพาะงานที่ยังไม่อยู่หมวด done (งานที่เสร็จแล้วยังแสดงชื่อเดิม) · เพิ่ม version ของงาน, เขียน Activity `assigneeIds`, เขียน `plan_changes` เมื่อมี Baseline (เหตุผลอัตโนมัติ "นำ X ออกจากโปรเจกต์") และส่ง `issue.updated`, `issue.assigned` (+ `plan.changed`) หลัง commit
- เพิ่ม `POST p/archive` · `POST p/restore` · `POST p/transfer` (`{ userId }`) · `GET p/delete-impact` (`issues`, `files`, `members`, `trashDays`, `canDelete`) · `DELETE p/` (`{ confirmKey }`, ไม่สนตัวพิมพ์เล็กใหญ่) · ลบแล้วตอบ `deletedAt`, `restorableUntil` ตาม `workspace_settings.trash_days` · โปรเจกต์ที่ลบแล้วตอบ `410 project_deleted` (รวม Issue key ของโปรเจกต์นั้น)
- Archive = อ่านอย่างเดียว: `projectAccess` ตัดสิทธิ์ทุกตัว เหลือ `project.view`, `project.workload.view`, `project.reports.view` และ `project.archive` (ไว้กด Restore) · `requirePerm` ตอบ `403 project_archived` แทน `forbidden` เมื่อโปรเจกต์ถูก Archive ทุก endpoint ที่ใช้ `requirePerm` จึงได้กติกานี้ (สร้าง / แก้งาน, คอมเมนต์, Checklist, ขอเลื่อน Due, ตั้งค่า, สมาชิก) · `GET w/projects?status=planning|active|archived` และรายการมี `archivedAt`
- `POST w/projects` รับ `templateId` · export `TemplateConfig` (zod) เป็นรูปแบบ `project_templates.config`: `workflow`, `issueTypes` (ปรับสี / ฟิลด์บังคับ / เปิดปิดของประเภทมาตรฐาน หรือเพิ่มประเภทใหม่ `bug: true` ใช้ Workflow ของ Bug), `customFields`, `labels`, `modules`, `sprintLengthWeeks`, `estimateUnit`, `progressMethod`, `sizeMdMap`, `timeLogEnabled` · ค่าที่ส่งมาใน body ชนะ Template เสมอ (Module ใช้ของ Template เมื่อ body ไม่ส่ง) · `usage_count` +1 · Template ไม่พบตอบ 404, config ผิดรูปแบบตอบ `422 template_invalid` โดยไม่สร้างอะไรเลย
- `POST w/projects` รับข้อมูลจาก Wizard เพิ่ม: `holidayCalendarId`, `extraHolidays`, `scope` (`in`, `out`, `deliverables`, `acceptance`, `assumptions`), `members` (ต้องเป็นสมาชิก Workspace ที่ active, Guest เป็น Admin ไม่ได้) และ `workflow` (ชื่ออย่างเดียวได้: แรก = todo, สุดท้าย = done) · สถานะ Bug ผูกคอลัมน์บอร์ดตามหมวดของ Workflow ที่ตั้งเอง · ยังไม่รับ `invites`, `ownerUserId`, `budget`, `requirementFileIds`
- เพิ่ม `POST w/projects/sample` (`{ key? }`): โปรเจกต์ "ร้านกาแฟออนไลน์ (ตัวอย่าง)" ข้อมูลสมมติ 3 Module, 9 งาน (มี Sub-task, Bug, งานที่เสร็จแล้ว) มอบหมายให้ผู้สร้าง · Key `DEMO`, `DEMO2` … ตัวแรกที่ว่าง · สร้างงานผ่าน `IssuesService.create` (แยกเป็น `SampleProjectService` เพราะ `IssuesService` พึ่ง `ProjectsService`)
- แก้บั๊กเดิม: สมาชิก Workspace ระดับ Member สร้างโปรเจกต์ไม่ได้ (403) เพราะ `INSERT … RETURNING` ของ `projects` ติด policy ฝั่ง SELECT (`accessible_project_ids()` ยังไม่เห็นแถวที่กำลัง INSERT) · เปลี่ยนเป็น INSERT ด้วย id ที่สร้างเอง แล้วอ่านกลับในคำสั่งถัดไป · มีผลกับ Import Excel ที่เรียก `createInTx` ด้วย
- Signature เดิมไม่เปลี่ยน: `ProjectRef` เพิ่ม `archivedAt?` (ไม่ส่งมา = อ่านจากฐานข้อมูลเอง) · `ProjectAccess` เพิ่ม `archived?` · `list()` รับ query เป็นพารามิเตอร์ที่ 3 แบบไม่บังคับ · `CreateProjectBody` ฟิลด์ `sprintLengthWeeks`, `estimateUnit`, `progressMethod` เปลี่ยนเป็นไม่บังคับ (ค่าเริ่มต้นย้ายไป `createInTx` เพื่อให้ Template เติมได้)

คำตัดสินที่เลือกเอง:

- Archive / Restore ใช้สิทธิ์ `project.archive` (04-permissions › 3.2, ตายตัวที่ Admin) แทน `project.settings` ใน 03-api › 3.4 เพราะ `project.settings` เปิดให้ Member ได้ที่ L2 · ค่าเริ่มต้นได้ผลเท่ากัน (Admin เท่านั้น)
- Restore ตั้งสถานะ `planning` ถ้ายังไม่ถึงวันเริ่ม ไม่อย่างนั้น `active` (ไม่มีคอลัมน์เก็บสถานะก่อน Archive)
- โอนความเป็นเจ้าของ: Project Owner หรือ Workspace Owner / Admin ที่เข้าร่วมโปรเจกต์แล้ว (กรณีโปรเจกต์กำพร้า 04-permissions ข้อ 6) · ผู้รับต้องเป็นสมาชิกโปรเจกต์ที่ active และไม่ใช่ Guest · ผู้รับเป็น Admin และเจ้าของเดิมยังเป็น Admin · แจ้งผู้รับใน Inbox (`project.transferred`) ผ่าน `SYSTEM_DB` แบบเดียวกับ `joinAsAdmin`
- ลบ / delete-impact: Project Owner หรือ Workspace Owner / Admin ตาม 03-api แต่ต้องเข้าร่วมโปรเจกต์ก่อน (ใช้ `load` ปกติ) ตามข้อ 6 · delete-impact เปิดให้คนที่มี `project.settings` ดูตัวเลขได้ด้วย (Danger zone แสดงตัวเลข) พร้อม `canDelete`
- 301 ไม่ใส่ header `Location` (ตอบ JSON อย่างเดียว) เพื่อไม่ให้ fetch ตามไปเองและเปลี่ยน method · alias อ่านผ่าน RLS จึงตอบ 301 เฉพาะคนที่เข้าโปรเจกต์ได้ คนอื่นได้ 404 เหมือน Key ที่ไม่มี
- ตั้งเป็น Admin ตอนเพิ่มสมาชิกต้องมี `project.settings` ด้วย (กัน Member ที่ PM เปิด `project.invite` ให้ยกระดับคนอื่น) · Project Owner เปลี่ยน Role เป็นอื่นไม่ได้ (`409 owner_role_fixed`) และถูกนำออกไม่ได้ (`409 owner_cannot_be_removed`) ต้องโอนก่อน · สมาชิกออกจากโปรเจกต์เองได้โดยไม่ต้องมี `project.settings` (ยกเว้นโปรเจกต์ถูก Archive)
- `GET p/members`: Guest Viewer ได้ 403 (ไม่เห็นชื่อคน) · Guest Member เห็นรายชื่อแต่ `email: null` · โอนงานตอนนำคนออกย้ายเฉพาะ Assignee ไม่แตะ BA / Reviewer / Tester / Watcher
- PATCH `sizeMdMap`, `holidayCalendarId`, `workStart`, `workEnd` เป็นค่าที่ไม่ใช่ null เมื่อ Workspace ปิด `allow_project_override` ตอบ `409 project_override_disabled` · เปลี่ยนปฏิทินวันหยุดตอบ warning `plan_end_not_recalculated` (ดูคำขอข้อ 1)
- คอลัมน์ "สัปดาห์นี้" (MD ที่มอบหมายในสัปดาห์) ในหน้า 7 ไม่อยู่ใน `p/members` เพราะเป็นการคิด Workload ของ A08

คำขอนอก lane / งานต่อ:

1. A05: เมื่อ `recalculatePlanEnds(tx, project)` merge แล้ว `PATCH p/` ที่เปลี่ยน `holidayCalendarId` ควรเรียกฟังก์ชันนี้และเลิกส่ง warning `plan_end_not_recalculated` (แก้ใน lane A04 ได้ภายหลัง) · การสร้างโปรเจกต์ (`createInTx`) ยังไม่ใส่แถว `workflow_rules` เริ่มต้น เพราะ `defaultWorkflowRules(kind)` ใน `project-structure/rules.ts` ของ A05 (PR #12) ยังไม่อยู่ใน main · เมื่อ A05 merge ควรใส่กฎเริ่มต้นจาก `defaultWorkflowRules()` ให้ทั้ง Workflow มาตรฐานและ Bug ในธุรกรรมเดียวกับการสร้างโปรเจกต์
2. A18: ตรวจ `config` ของ `w/project-templates` ด้วย `TemplateConfig` ที่ export จาก `projects.service.ts` ให้ Template ที่บันทึกแล้วใช้สร้างโปรเจกต์ได้เสมอ
3. A03: `CreateIssueBody.type` จำกัดแค่ Story / Task / Bug / Spike ประเภทใหม่จาก Template (เช่น Incident) จึงยังสร้างงานผ่าน API ไม่ได้
4. Invitations (`invitations.service.ts`): Workspace Owner / Admin เชิญเข้าโปรเจกต์ที่ถูก Archive ได้ เพราะข้าม `requirePerm` · ควรตรวจ `access.archived` · Watch / Unwatch (A01) ยังทำได้ในโปรเจกต์ที่ Archive เพราะใช้แค่ `project.view` (เป็นเรื่องส่วนตัว จึงคิดว่ายอมรับได้)
5. A16 / A23: งานลบโปรเจกต์ถาวรเมื่อเลย `restorableUntil` และ endpoint กู้คืนโปรเจกต์ที่ลบ (`ws.owner`) ยังไม่มีงานไหนรับ · `EventType` ยังไม่มี event ของโปรเจกต์ (`project.archived`, `project.transferred`, `project.deleted`) ถ้า A23 / Webhook ต้องการให้เพิ่มต่อท้าย union
6. D99: เพิ่ม endpoint / ฟิลด์ข้างบน, รูปแบบ `TemplateConfig` และ error code ใหม่ (`project_moved`, `project_deleted`, `project_archived`, `member_has_open_issues`, `owner_role_fixed`, `owner_cannot_be_removed`, `guest_role_limit`, `template_invalid`, `project_override_disabled`, `confirm_key_mismatch`) ลง 03-api

ผลตรวจ: `projects.e2e.test.ts` 17 tests (เริ่มจาก `startApp()` + `seedTeam()`) ครอบคลุม PATCH / If-Match / ETag / สิทธิ์ / วันที่ / override, เปลี่ยน Key + 301 ทุกเส้นทางผ่าน `load` และเปลี่ยนกลับ, สมาชิก (รายการ, เพิ่ม, แก้, นำออกพร้อมโอนงาน / ไม่ระบุ / ออกเอง, Guest), Archive / Restore อ่านอย่างเดียว, โอน (Owner และ Workspace Admin), ลบ + delete-impact + 410, Template + Wizard และโปรเจกต์ตัวอย่าง · `pnpm typecheck` ผ่านทุกแพ็กเกจ และ `pnpm test` ผ่าน Web 52, DB 105, API 116 tests (มี 2 tests เดิมที่ skip) · ใช้ฐานทดสอบแยก `friday_a04`
