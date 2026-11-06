# A26 · Automation (เมื่อ … ถ้า … ให้ …)

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | T00, A16, A03 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/automation/**` · `apps/api/test/automation.e2e.test.ts` |
| หน้าจอ | P2 (`design/canvas/Automation.dc.html`) |
| สเปก | 03-api › 3.9 แถว automations · 01-entities › K |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `CRUD p/automations` · `GET automation-templates` · `POST p/automations/{id}:dry-run` · `GET p/automations/runs`
- เครื่องยนต์ฟัง `EventBus` · เงื่อนไขตามฟิลด์งาน · การกระทำ: ตั้งฟิลด์, มอบหมาย, ย้ายสถานะ, เพิ่มคอมเมนต์, แจ้งเตือน · บันทึก `automation_runs`
- กันวนซ้ำ: การกระทำของ Automation ไม่ trigger Automation ต่อเกิน 1 ชั้น

## กติกาที่ต้องตรง

- การกระทำผ่าน method ของ `IssuesService` · ถ้าต้องการ method สำหรับผู้กระทำที่เป็นระบบ ให้เขียนใน "คำขอนอก lane"

## เสร็จเมื่อ

- [x] test: dry-run ไม่บันทึก, กฎย้ายสถานะทำงาน, วนซ้ำถูกหยุด
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

### Endpoint (`apps/api/src/automation/`) · Project Admin (`project.automation`) · Member/Viewer/Guest → 403

| Method | Path | หมายเหตุ |
|---|---|---|
| GET | `w/:ws/projects/:key/automations` | `items[]` (กฎ + `sentence` อ่านเป็นประโยค + `stats30d {runs, failed, lastRunAt}` + `createdBy`) และ `usage {runsThisMonth, quota: 1000}` (แสดงอย่างเดียว ยังไม่บังคับโควตา) |
| POST / GET:id / PATCH / DELETE | `.../automations` (`/:id`) | PATCH เปิด/ปิดด้วย `{ enabled }` · ตรวจชื่อสถานะ / ผู้ใช้ / config ของ trigger · ≤ 50 กฎต่อโปรเจกต์ · เขียน Audit `automation.created/updated/enabled/disabled/deleted` |
| POST | `.../automations/:id/dry-run` (และ `:id\:dry-run`) | `{ issueKey?, limit? }` → `{ checked, matched, items[{key,title,status,wouldDo[{action,text,warning?}]}], notes }` · **ไม่เขียนอะไร** (ไม่มี run / activity / แจ้งเตือน / audit) |
| GET | `.../automations/runs?ruleId&result&limit&before` | `items[{rule, issueKeys, result, depth, detail, ranAt}]` + `nextCursor` |
| GET | `w/:ws/automation-templates` | แม่แบบ 8 ชุด (Workflow, Bug, ติดตาม, Sprint, QA) พร้อม `rule` ที่ส่งเข้า `POST automations` ได้ทันที · สมาชิกที่ไม่ใช่ Guest |

**Trigger**: `issue_created` · `status_changed {from?, to?}` · `subtasks_done` (ลูกทุกตัวเสร็จ → ทำกับงานแม่) · `overdue` · `test_attached` · `sprint_started` · `sprint_completed` (ทำกับทุกงานใน Sprint) · `schedule {frequency: daily|weekly, time, weekday?}`
**เงื่อนไข** (AND, `not` กลับผล, op `eq/in/gt/lt/empty/not_empty`): type, status, statusCategory, priority, assignee, label, module, severity, estimateMd, daysToDue, isSubtask
**การกระทำ** (ตามลำดับ): `set_status` · `assign {add|set|clear}` · `set_priority` · `add_label` · `add_watcher` · `create_subtask` · `comment` · `notify {assignees|reporter|project_owner|users}`

### วิธีทำงาน

- `AutomationEngine` ฟัง `EventBus` (`issue.created`, `issue.status_changed`, `sprint.*`, `test_run.failed`) แล้วรันกฎของโปรเจกต์ใน **คำขอเดียวกับเหตุการณ์** (publish ถูก await) · งานตามเวลา: `automation.schedule` (ทุก 5 นาที) และ `automation.overdue` (ทุกชั่วโมง) ผ่าน `Jobs.every`
- การกระทำเรียก `IssuesService.patch/create` และ `CommentsService.create` **ในนามผู้สร้างกฎ** (ใช้สิทธิ์ของเขา · ผู้สร้างถูกปิดบัญชีแล้ว = run `failed` `creator_inactive`) · แก้เนื้อหากฎ (ไม่ใช่แค่เปิด/ปิด) = ผู้แก้กลายเป็นผู้สร้างกฎ เพื่อไม่ให้ยกระดับสิทธิ์ผ่านกฎของคนอื่น
- **ลงชื่อ "Automation"**: หลังรันกฎ แถว `activities` ของงานที่ถูกแตะซึ่งเกิดจากผู้สร้างกฎ ถูกแก้เป็น `actor_kind = 'automation', actor_id = null` · คอมเมนต์ขึ้นต้น `[Automation: <ชื่อกฎ>]` · ทุก run เขียน `audit_logs` (`automation.run`, actor_kind automation)
- **ชนเวอร์ชัน**: `PATCH` ที่ได้ 409 `conflict` โหลดงานใหม่แล้วลองอีกครั้งเดียว → `result = 'retried'`
- **กันวนซ้ำ** ด้วยสองชั้น (ผ่าน `AsyncLocalStorage` ตามสาย async ของเหตุการณ์): (1) กฎเดิมกับงานเดิมในสายเดียวกันไม่ทำซ้ำ → `skipped` `reason: loop` (2) กฎที่ถูกเรียกต่อกันเกิน 3 ชั้น → `skipped` `reason: depth_exceeded` (`depth` ใน DB ถูก clamp ที่ 3 ตาม CHECK, ค่าจริงอยู่ใน `detail.attemptedDepth`)
- เงื่อนไขไม่ตรง = กฎไม่ทำงาน ไม่บันทึก run (ไม่งั้นประวัติท่วมทุกเหตุการณ์)

### คำตัดสินที่เลือกเอง

- **ชั้นสูงสุด = 3 ตาม Canvas P2 และ 01-entities** (`automation_run.depth ≤ 3`) ไม่ใช่ 1 ชั้นตามไฟล์งาน → ตาม AGENTS.md ให้ยึดหน้าจอ
- **สิทธิ์ = `project.automation`** (Project Admin) ตาม 04-permissions ไม่ใช่ `project.settings` ตาม 03-api (เหมือนที่ A07 เลือกกับ Baseline) · แก้ที่ 03-api ใน D99
- Label / Watcher ไม่มี method ใน `IssuesService` จึงเขียนตารางตรงภายใต้ RLS ของผู้สร้างกฎ + บันทึก activity เอง · `CommentsService` ไม่ถูก export จาก `CommentsModule` จึงประกาศเป็น provider ของ `AutomationModule` เอง (ไม่แตะ lane ของคนอื่น)
- `overdue`: ไม่มีใครส่ง Event `issue.overdue` จึงสแกนเอง ครั้งเดียวต่อกฎต่องานต่อวัน Due (`detail.dedupe = issueId:planEnd`) · `schedule`: วันละครั้งต่อกฎต่อ slot (`detail.slot`), ทำกับงานที่ยังไม่เสร็จที่ตรงเงื่อนไข ≤ 200 งาน
- `test_attached` ใช้ Event `test_run.failed` (ตัวเดียวที่ A19 ส่ง) · แจ้งเตือน = `eventType: 'automation.notified'` (ผู้กระทำเป็นระบบ จึงไม่ตัดผู้รับคนไหนออก)
- ไม่ทำ "ส่งเข้า LINE กลุ่ม / Webhook" และ "สร้างกฎจากแม่แบบด้วย id" (หน้าเว็บส่ง `rule` ของแม่แบบเข้า POST ตรง ๆ) ในรอบนี้

### คำขอนอก lane

- **A03**: ถ้าอยากให้กิจกรรมลงชื่อ Automation ตรงจุด ควรมี `IssuesService.patch(..., { actor: 'automation' })` หรือเมธอดสำหรับผู้กระทำที่เป็นระบบ — ตอนนี้แก้ `activities` ภายหลังด้วย `SYSTEM_DB` (จำกัดที่ issue ที่ถูกแตะ + ผู้สร้างกฎ + ช่วงเวลา)
- **A19 (qa)**: ส่ง Event เมื่อแนบผลทดสอบทุกผล (ตอนนี้มีแค่ `test_run.failed`)
- **A23 / inbox**: เพิ่มชนิดแจ้งเตือน `automation.notified` ในแคตตาล็อก (`me/prefs-catalog`) เพื่อให้ผู้ใช้ปิดรับได้
- **W (P2)**: ใช้ `sentence` จาก API แสดง "อ่านเป็นประโยค" และ `dry-run` ปุ่ม "ทดสอบกับงานจริง"
- **D99**: 03-api 3.9 สิทธิ์ `project.automation`, path `automation-templates` อยู่ใต้ `w/`, query/ผลของ `runs`

### ผล test

`apps/api/test/automation.e2e.test.ts` 17 ข้อ: CRUD + Audit + ตรวจข้อมูล 14 กรณี + สิทธิ์ (Member/Guest 403) + แม่แบบทุกชุดสร้างเป็นกฎได้จริง · issue_created (ตั้ง Priority, Label, Watcher, คอมเมนต์, แจ้งเตือน, กิจกรรมลงชื่อ Automation, Audit, เงื่อนไขไม่ตรง = ไม่ทำงาน) · status_changed (กฎย้ายสถานะ + ตัวกรองจาก/เป็น) · subtasks_done · create_subtask/assign/clear · test_attached · **dry-run ไม่เขียนอะไร** (นับแถว activities/notifications/runs/audit ก่อน-หลังเท่ากัน) + คำเตือน · **วนซ้ำ A↔B ถูกหยุด** · **สายโซ่ 5 กฎหยุดที่ชั้น 3** · create_subtask ซ้ำตัวเองล้มที่ Sub-task ซ้อน · overdue ครั้งเดียวต่อ Due · schedule (เวลาไทย/วัน/ครั้งเดียวต่อ slot) · runs (กรอง/แบ่งหน้า/ผู้สร้างถูกปิดบัญชี) · ตัวดำเนินการเงื่อนไข · `pnpm typecheck` ผ่าน · API 495 ผ่าน (ข้าม 6 = เดิม) · **ยังไม่มี test ของ `retried`** (ชนเวอร์ชันจำลองยาก)
