# A05 · โครงสร้างโปรเจกต์: Module, กลุ่มงาน, Milestone, Workflow, ประเภทงาน, Field, Label, วันหยุด

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | — เริ่มได้เลย |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/project-structure/**` · `apps/api/test/project-structure.e2e.test.ts` |
| หน้าจอ | L2 (`design/canvas/ProjectSettings.dc.html`) · A (`design/canvas/NewProject.dc.html`) |
| สเปก | 03-api › 3.5 ตั้งค่าโปรเจกต์ (L2) · 01-entities › D, E |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `CRUD + reorder p/modules`, `p/modules/{id}/phases` · ลบ Module / กลุ่มงานที่มีงานต้องส่ง `moveTo`
- `CRUD p/milestones` และ `p/milestones/{id}/issues`
- `CRUD + reorder p/workflows/{id}/statuses` (category, `boardColumnId` สำหรับ Workflow Bug, `wipLimit`) · ลบสถานะที่มีงานต้องส่ง `moveTo` · Workflow ต้องมีสถานะ todo และ done อย่างน้อยอย่างละ 1
- `CRUD p/workflows/{id}/rules` · กำหนด ruleType ที่รองรับและเขียนไว้ในไฟล์ `rules.ts` ที่ export ให้ A03 ใช้ตรวจ
- `GET / PATCH p/issue-types/{id}` (เปิดปิด, ฟิลด์บังคับ) · `CRUD p/custom-fields`, `p/labels`
- `GET / POST p/holidays` · `DELETE p/holidays/{id}` → คำนวณ Plan End ใหม่ของงานที่ยังไม่เสร็จที่ช่วงวันคร่อมวันนั้น (ทำในธุรกรรมเดียว) · export ฟังก์ชัน `recalculatePlanEnds(tx, project)` ให้ A18 ใช้ตอนวันหยุดของ Workspace เปลี่ยน
- ไม่ทำ `GET p/settings` แบบรวม: หน้าเว็บเรียกรายแท็บ (บันทึกเป็นข้อตกลงใน "บันทึกผล")

## กติกาที่ต้องตรง

- ต้องมี `project.settings` (อ่านได้ด้วย `project.view`)
- คำนวณ Plan End ใหม่หลังมี Baseline เขียน `plan_changes` เหตุผล "วันหยุดเปลี่ยน"

## เสร็จเมื่อ

- [x] test ครอบคลุมทุกข้อ รวมเพิ่มวันหยุดแล้ว Plan End เลื่อน
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- สมาชิกโปรเจกต์ (A04)
- Repository (A27)
- แจ้งเตือนโปรเจกต์ (A25)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

- ข้อตกลง: ไม่มี `GET p/settings` แบบรวม · หน้า L2 เรียกรายแท็บตาม endpoint ด้านล่าง (prefix `w/{ws}/projects/{key}/`) · `:reorder` ใช้ `/reorder` (รับ `\:reorder` ด้วย) แบบเดียวกับ A02
- Module: `GET / POST modules`, `PATCH / DELETE modules/{id}`, `POST modules/reorder` · list มี `owner` (person DTO), `issueCount` และ `phases[]` · เจ้าของ Module ต้องเป็นสมาชิกโปรเจกต์ · ลบ Module ที่มีงานต้องส่ง `moveTo` (query หรือ body) ไม่งั้น `409 module_has_issues` · งานทั้งหมดรวม Sub-task และงานในถังขยะย้ายไป Module ใหม่และล้างกลุ่มงาน, กลุ่มงานของ Module ถูกลบ, Milestone ที่ผูกเลิกผูก (`moduleId = null`) · Module ที่มีแต่งานในถังขยะไม่ต้องส่ง `moveTo` งานเหล่านั้นเหลือ `moduleId = null`
- กลุ่มงาน: `GET / POST modules/{id}/phases`, `PATCH / DELETE modules/{id}/phases/{phaseId}`, `POST modules/{id}/phases/reorder` · ลบกลุ่มงานที่มีงานต้องส่ง `moveTo` = กลุ่มงานใน Module เดียวกัน หรือ `"none"` (ไม่ระบุกลุ่มงาน) ไม่งั้น `409 phase_has_issues`
- Milestone: `GET / POST milestones`, `PATCH / DELETE milestones/{id}`, `GET / POST milestones/{id}/issues` (body `{ keys[] }` ส่งซ้ำได้), `DELETE milestones/{id}/issues/{issueKey}` · list มี `issueCount`, `doneCount`, `progressPct` (งานที่ผูกและเสร็จ ÷ ทั้งหมด นับตามจำนวน)
- Workflow: `GET workflows` (สถานะ + จำนวนงาน, ประเภทงานที่ใช้, กฎ และ `catalog`) · `GET / POST workflows/{id}/statuses`, `PATCH / DELETE workflows/{id}/statuses/{statusId}`, `POST workflows/{id}/statuses/reorder` · ชื่อสถานะไม่ซ้ำใน Workflow (`409 status_name_taken`) · Workflow ต้องเหลือหมวด todo และ done อย่างน้อยอย่างละ 1 ทั้งตอนลบและเปลี่ยนหมวด (`422 workflow_needs_todo_done`) · `wipLimit` 1–999 หรือ null · `boardColumnId` ต้องชี้สถานะของ Workflow อื่นที่เป็นคอลัมน์เอง (`422 invalid_board_column`) และสถานะที่เป็นคอลัมน์ให้ Workflow อื่นอยู่จะไปผูกคอลัมน์ไม่ได้
- ลบสถานะที่มีงานต้องส่ง `moveTo` ใน Workflow เดียวกัน (`409 status_has_issues`) · งานย้ายพร้อม activity และส่ง `issue.updated` + `issue.status_changed` หลัง commit · ไม่แก้ Actual Start / End เพราะเป็นการจัดโครงสร้าง ไม่ใช่งานเดินหน้า · สถานะ Bug ที่ใช้สถานะนี้เป็นคอลัมน์ย้ายไปคอลัมน์ปลายทาง · กฎที่อ้างสถานะนี้ใน `config` ถูกลบและตอบใน `removedRules`
- กฎ: `GET / POST workflows/{id}/rules`, `PATCH / DELETE workflows/{id}/rules/{ruleId}` · body `{ ruleType, config: { fromStatusId?, toStatusId? }, enabled }` · สถานะใน config ต้องอยู่ใน Workflow นี้ · กฎชนิดเดียวกันที่ config เดียวกันซ้ำไม่ได้ (`409 rule_exists`) · ตรวจจริงตอนย้ายสถานะโดย `issues/rules.ts` ของ A03 (test ยืนยัน: เปิด → 422, ปิด → ย้ายได้ และแถว disabled ปิด fallback ของ Sub-task ได้)
- `project-structure/rules.ts` ไม่ประกาศชื่อกฎใหม่: re-export `SUPPORTED_WORKFLOW_RULE_TYPES`, `enforceWorkflowRules`, `workflowRuleEnabled` จาก `issues/rules.ts` แล้วเพิ่ม `WORKFLOW_RULES` (ชื่อ/คำอธิบายตามหน้าจอ, kind = transition · warning · event, Workflow ที่แสดง, ค่าเริ่มต้นของหน้าจอ และ `implicitEnabled` = พฤติกรรมเมื่อไม่มีแถวตาม fallback ของ A03) ด้วย `satisfies Record<ชื่อกฎ, …>` · เพิ่มชื่อกฎที่ `issues/rules.ts` แล้ว typecheck บังคับให้เติมคำอธิบายที่นี่ · `catalog` บอกสถานะที่มีผลจริง (`configured`, `enabled`) · export `defaultWorkflowRules(kind)` ให้ใช้ตอนสร้างโปรเจกต์
- ประเภทงาน: `GET issue-types` (พร้อม `requiredFieldOptions`), `GET / PATCH issue-types/{id}` · PATCH รับ `enabled`, `requiredFields`, `color` · ฟิลด์บังคับเลือกได้เฉพาะคีย์ที่ `IssuesService.checkRequired` ตรวจจริง (title, module, size, user_story, acceptance_criteria, severity, environment, steps, question, timebox) · `title` บังคับเสมอ · ปิดประเภทสุดท้ายไม่ได้ (`422 last_issue_type`) · test ยืนยันว่าปิด Spike แล้วสร้าง Spike ไม่ได้ และตั้ง Size เป็นฟิลด์บังคับแล้วสร้าง Task ที่ไม่มี Size ได้ 400
- Custom field: `GET / POST custom-fields`, `PATCH / DELETE custom-fields/{id}` · select / multi_select ต้องมี `options.choices[]` แต่ละตัวเลือกมี `id` คงที่ (ระบบออกให้ถ้าไม่ส่ง) เพื่อแก้ชื่อตัวเลือกได้โดยค่าในงานไม่หาย · ถือว่าค่าในงานเก็บเป็น id ของตัวเลือก (select) หรือ array ของ id (multi_select) · เอาตัวเลือกที่มีงานใช้ออก `409 choice_in_use` · เปลี่ยนชนิดฟิลด์ที่มีค่าแล้ว `409 custom_field_in_use` · ลบฟิลด์ลบค่าในทุกงาน (cascade) · ชื่อซ้ำ (ไม่สนตัวพิมพ์) `409 custom_field_exists`
- Label: `GET / POST labels`, `PATCH / DELETE labels/{id}` · list มี `issueCount` · ชื่อซ้ำ (ไม่สนตัวพิมพ์) `409 label_exists` · ลบแล้วหลุดจากทุกงาน
- วันหยุด: `GET holidays?from=&to=` (วันหยุดของโปรเจกต์ + ปฏิทินหลักในช่วง ค่าเริ่มต้น = วันเริ่ม–Go-live), `POST holidays` (`409 holiday_exists` · วันที่เป็นวันหยุดอยู่แล้วตอบ warning `already_non_working`), `DELETE holidays/{id}` · ตอบ `{ holiday, recalculated: [{ key, planStart, planEnd: { from, to } }], warnings }`
- `recalculatePlanEnds(tx, project, { previous?, actorId?, reason? })` ใน `project-structure/plan-ends.ts`: เรียกในธุรกรรมเดียวกับที่แก้วันหยุด · เลือกงานที่ยังไม่เสร็จและไม่อยู่ในถังขยะที่ช่วง Plan Start–End มีวันที่สถานะวันทำการเปลี่ยน · รักษาจำนวนวันทำการเดิมของงาน (นับบนปฏิทิน `previous`) แล้วนับใหม่บนปฏิทินปัจจุบัน จึงใช้ได้ทั้งงานที่คิดจาก Man-Day และงานที่กำหนด Plan End เอง · Plan Start ที่กลายเป็นวันหยุดเลื่อนไปวันทำงานถัดไป (ลบวันหยุดแล้วไม่ย้อนกลับ) · ล็อกแถวงานและแถวโปรเจกต์กันคำขอชนกัน · เขียน activity (actor_kind = system เมื่อไม่มีผู้แก้) · หลังมี Baseline เขียน `plan_changes` เหตุผล "วันหยุดเปลี่ยน" ทุกฟิลด์ที่เปลี่ยน · คืน `events` (`issue.updated` และ `plan.changed` เมื่อมี Baseline · data มี `reason`, `source: 'holiday'`, `planStart`, `planEnd`) ให้ผู้เรียก publish หลัง commit
- ไม่ส่ง `previous` (รูป `recalculatePlanEnds(tx, project)` ตามไฟล์งาน) = คิดใหม่ตามสูตร WORKDAY จาก Man-Day เฉพาะงานที่มี Man-Day และไม่มี Sub-task (Task ที่มีลูกมีช่วงตามลูก ใช้สูตรไม่ได้) · แนะนำให้ A18 โหลด `WorkCalendar.load(tx, project)` ก่อนแก้วันหยุดของ Workspace แล้วส่งเป็น `previous` เพื่อไม่ให้ Plan End ที่กำหนดเองถูกเปลี่ยน
- สิทธิ์: อ่านต้องมี `project.view` · แก้ต้องมี `project.settings` และโปรเจกต์ไม่ถูกเก็บถาวร (`403 project_archived`) · Guest (ทั้ง Viewer และ Member) ไม่เห็น Settings ตาม 04-permissions ข้อ 4 จึงได้ `403 guest_settings_hidden` ทุกแท็บ ยกเว้น Milestone ที่ Overview / Timeline ใช้: Guest ที่เป็น Viewer ไม่นับ/ไม่เห็น Bug และได้ `canOpen` ตาม `sharedWithGuests` · การลบ, การเปิดปิดกฎ/ประเภทงาน, Milestone และวันหยุดบันทึก Audit log
- ต่างจากสเปก: 03-api เขียนว่าเพิ่ม/ลบวันหยุด "เข้าคิวคำนวณ Plan End ใหม่" · ทำแบบ synchronous ในธุรกรรมเดียวตามไฟล์งาน (แผนหนึ่งโปรเจกต์หลักร้อยงาน) · enum `plan_change_source` ไม่มีค่าสำหรับวันหยุด จึงใช้ `manual` + เหตุผล "วันหยุดเปลี่ยน"
- คำขอนอก lane:
  - A04: ตอนสร้างโปรเจกต์ใส่แถว `workflow_rules` จาก `defaultWorkflowRules('standard' | 'bug')` ให้กฎเริ่มต้นตรงหน้าจอ (Reviewer required, กฎของ Bug) · ตอนนี้โปรเจกต์ที่ยังไม่มีแถวใช้ fallback ของ A03 (Sub-task และ WIP เปิด กฎอื่นปิด) และ `catalog` แสดงสถานะนี้ตามจริง
  - T00: เพิ่ม `holiday` (หรือ `system`) ใน enum `plan_change_source` เพื่อแยกการแก้ไขแผนที่ระบบทำจากวันหยุด
  - A03: รายชื่อฟิลด์บังคับซ้ำกันระหว่าง `IssuesService.checkRequired` กับ `REQUIRED_FIELD_OPTIONS` ของงานนี้ · ถ้า export คีย์จาก issues จะกันไม่ให้สองที่ไม่ตรงกัน
  - views (ไฟล์กลาง): `loadProjectData` ใช้ `Promise.all` ภายในธุรกรรมเดียว ทำให้ pg เตือน `client.query() when the client is already executing` ตอนเรียก `/board` (เห็นใน test ของงานนี้ ไม่กระทบผล)
  - A26 / A27: config ของ Automation และการย้ายสถานะอัตโนมัติของ Repository ที่อ้าง id สถานะต้องรับมือเมื่อสถานะถูกลบ (งานนี้จัดการเฉพาะงาน, คอลัมน์บอร์ด และ workflow_rules)
- คำถามที่ค้าง: % ของ Milestone นับตามจำนวนงาน (ไม่ถ่วง Man-Day) · ลบกลุ่มงานย้ายข้าม Module ไม่ได้ · ลบ Module ล้างกลุ่มงานของงานที่ย้ายแทนการให้เลือกกลุ่มงานปลายทาง · `catalog` ของ Workflow Bug ไม่แสดง `subtasks_done` แม้ fallback ของ A03 เปิดกฎนี้ให้ทุก Workflow
- ตรวจผ่าน: `pnpm typecheck`, `pnpm test` ทั้ง workspace: DB 105, API 118 (ใหม่ 19 ใน `project-structure.e2e.test.ts`) + 2 skipped ตาม environment เดิม, Web 52 · ทดสอบด้วยฐาน `friday_a05` แยกจากงานอื่น
