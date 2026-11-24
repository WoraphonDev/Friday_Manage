# F01 · Template ของโปรเจกต์ + ชุดฟิลด์ของ Task / Sub-task

| | |
|---|---|
| Wave | หลังทุกงานเดิม (ผู้ใช้สั่ง 2026-11-09) |
| รอ merge | — |
| Lane | ข้ามหลาย lane (งานเดียวทำครบทั้ง DB / API / เว็บ) · `packages/db/**` · `apps/api/src/projects/**`, `issues/**`, `project-structure/fields.service.ts`, `admin/templates.service.ts`, `imports/export.ts` · `apps/web/src/lib/field-profile.ts`, `src/features/field-profile/**`, `src/features/issue-drawer/**`, หน้า Table / Settings / New project / Admin |
| หน้าจอ | A (`NewProject.dc.html`) · L2 (`ProjectSettings.dc.html`) · Table · C2 / D2 / B2 (Drawer) · Admin Console |

## ทำอะไร

ผู้ใช้ต้องการให้ Demo Development Plan 2026-11 เป็น Template "Development" ตอนสร้างโปรเจกต์ และจะมี Template อื่นตามหมวด (Software development, Service management, Work management, Product management, Marketing, Customer service, Human resources, Finance, Design, Personal, Operations, Legal, Sales, Analytics) ที่แสดงคอลัมน์ใน Table และฟิลด์ของ Task / Sub-task ไม่เท่ากัน · งานนี้ทำโครงให้ระบบรองรับก่อน ยังไม่ทำ Template ของหมวดอื่น

คำตัดสินของผู้ใช้ (2026-11-09):

1. มีทั้ง Template ในตัวของระบบ และ Template ขององค์กรที่ Admin สร้าง (คัดลอกจาก Template ในตัวแล้วปรับต่อได้)
2. สร้างโปรเจกต์แล้วแก้ชุดฟิลด์ต่อได้ใน Settings · Template เป็นแค่จุดเริ่มต้น
3. ปิดฟิลด์ที่มีข้อมูลแล้ว = ซ่อนแต่เก็บค่าเดิม เปิดกลับมาก็เห็นค่าเดิม

## เสร็จเมื่อ

- [x] ชุดฟิลด์ (แสดง / บังคับ / ซ่อน แยก Task กับ Sub-task) และคอลัมน์ Table เก็บต่อโปรเจกต์ · คัดลอกจาก Template ตอนสร้าง
- [x] Template ในตัว Development (ค่าเริ่มต้นในหน้าสร้างโปรเจกต์), Scrum, Kanban, Waterfall, Blank · Template ขององค์กรมีหมวด
- [x] Custom field ใช้ได้จริงในงาน (สร้าง / แก้ / Table / Drawer / Activity / Export)
- [x] API บังคับใช้ชุดฟิลด์ (ฟิลด์บังคับ, ฟิลด์ที่ซ่อนรับค่าใหม่ไม่ได้)
- [x] `pnpm typecheck` และ test ของทุกแพ็กเกจผ่าน · deploy Docker ในเครื่องแล้วตรวจผ่านเบราว์เซอร์

## บันทึกผล

**ฐานข้อมูล (migration 0015)**
- `projects.field_profile jsonb default '{}'` = `{ fields: { <ฟิลด์>: { task, subtask } }, columns: [...], template: { id, name, builtin } }` · `{}` (โปรเจกต์เดิม) = ค่าเริ่มต้นเหมือนก่อนมีฟีเจอร์: ทุกฟิลด์ "แสดง" และคอลัมน์ Table ชุดเดิม
- `custom_fields.task_mode`, `subtask_mode` (enum `field_mode`: `hidden` / `optional` / `required`, ค่าเริ่มต้น `optional`)

**ฟิลด์ที่ Template เปิด / ปิดได้** (`apps/api/src/projects/field-profile.ts` · ฝั่งเว็บ `src/lib/field-profile.ts`)
- `ba`, `sa`, `reviewer` (QA / Reviewer), `priority`, `size`, `actual` (Actual Start / End), `progress`, `requirements`, `screens`, `labels`, `remark` + Custom field ของโปรเจกต์
- ฟิลด์แกนกลางซ่อนไม่ได้: ชื่องาน, สถานะ, Developer, Plan Start / End, Man-Day, Module / กลุ่ม (Gantt / Workload / Overview ใช้คำนวณ)
- ตั้งเป็น "บังคับ" ไม่ได้: `priority` (มีค่าเริ่มต้นเสมอ), `actual`, `progress` (ระบบตั้งให้) → `400 field_not_requirable`
- คอลัมน์ Table: `dev, ba, sa, reviewer, status, priority, size, start, end, actualStart, actualEnd, refs, labels, progress, remark, cf:<id>` · ฟิลด์ที่ซ่อนทั้งสองระดับ คอลัมน์ถูกตัดออกเอง · คอลัมน์ใหม่ `reviewer`, `priority`, `labels` เปิดได้จากเมนู Columns

**API**
- `GET w/projects/template-catalog` (สมาชิกทุกคนที่ไม่ใช่ Guest): `{ categories, items: [{ id, source: builtin|workspace, category, name, description, config, invalid, usageCount }] }`
- `POST w/projects` รับ `builtinTemplate` (`development` / `scrum` / `kanban` / `waterfall` / `blank`) หรือ `templateId` อย่างใดอย่างหนึ่ง · Member สร้างโปรเจกต์จาก Template ขององค์กรได้แล้ว (เดิมหน้าเว็บให้เฉพาะ Admin เห็น)
- `TemplateConfig` เพิ่ม `category`, `fields`, `columns` (Custom field อ้างด้วย `cf:<ชื่อ>`), `customFields[].taskMode / subtaskMode` · ตัวเลือกของ Custom field ที่ไม่มี id ได้ id ตอนสร้างโปรเจกต์
- `POST w/project-templates` รับ `fromBuiltin` (คัดลอก config ของ Template ในตัว แล้วรวม `fields` รายฟิลด์กับที่ส่งมา)
- `GET / PUT p/field-profile` (PUT ต้องมี `project.settings`) · `GET p/` และ `GET p/form-options` มี `fieldProfile` และ `customFields`
- `POST / PATCH p/custom-fields` รับ `taskMode`, `subtaskMode` · ฟิลด์ใหม่ต่อท้ายคอลัมน์ Table
- งาน: `customFields: { [fieldId]: ค่า }` ทั้งสร้างและแก้ (null = ล้าง) · DTO มี `customFields` (Guest ไม่ได้รับ) · Table มี `reviewer` (คน) · ตรวจชนิดค่า (`400 invalid_custom_field`), คนต้องเป็นสมาชิก Workspace
- บังคับใช้ชุดฟิลด์เฉพาะคำขอจากผู้ใช้ผ่าน API (`strict`) และไม่ใช้กับ Bug (Bug ใช้ฟิลด์บังคับของประเภทงานเหมือนเดิม): สร้างงานขาดฟิลด์บังคับ / แก้จนฟิลด์บังคับว่าง → `400 missing_required_fields` · ส่งค่าใหม่ให้ฟิลด์ที่ซ่อนในระดับนั้น → `422 field_hidden` (ส่งค่าเดิมซ้ำได้) · Automation, โปรเจกต์ตัวอย่าง, Bug จากผลทดสอบ ไม่ถูกบังคับ เพื่อไม่ให้งานอัตโนมัติล้ม
- Activity ของ Custom field: `field = cf:<id>`, ค่าเป็นชื่อตัวเลือก · Event `issue.updated` มี `customFields` ใน fields
- Export: ไม่ส่งออกคอลัมน์มาตรฐานที่ซ่อนทั้งสองระดับ (นำเข้ากลับแล้วไม่แตะค่าเดิม ตามกติกาเดิม) · ต่อท้ายคอลัมน์ Custom field ด้วยค่าที่อ่านได้ (ชื่อซ้ำคอลัมน์มาตรฐาน ต่อท้าย "(Custom)")

**เว็บ**
- สร้างโปรเจกต์: Template จัดตามหมวด (แสดงเฉพาะหมวดที่มี Template) · Development เลือกไว้ก่อนและตั้งความคืบหน้าแบบถ่วงน้ำหนัก · ส่ง `builtinTemplate`
- Settings › ประเภทงาน: "ชุดฟิลด์ของ Task / Sub-task" แทนป้ายฟิลด์มาตรฐานเดิม · ตั้งโหมดแต่ละระดับ, เลือก / เรียงคอลัมน์ Table, บอกว่าสร้างจาก Template ไหน · เพิ่ม Custom field เลือกโหมดได้
- Admin Console › Template: สร้างจาก Template ในตัว + หมวด · ปุ่ม "ชุดฟิลด์" แก้ฟิลด์ / คอลัมน์ / Custom field ของ Template
- Table: คอลัมน์ตามชุดฟิลด์ของโปรเจกต์ · แต่ละคนเปิด / ซ่อนเองได้ (จำในเครื่อง, มีปุ่มคืนค่าตามโปรเจกต์) · ฟิลด์ที่ซ่อนเฉพาะระดับแสดง "—" ในแถวระดับนั้น · แก้ Custom field ในแถวได้ทุกชนิด
- Drawer (ดู / สร้าง Task และ Sub-task): ซ่อนฟิลด์ที่ปิด, `*` ที่ฟิลด์บังคับ, ส่วน "ฟิลด์เพิ่มเติม" สำหรับ Custom field · ฟอร์มสร้างไม่ส่งฟิลด์ที่ซ่อนและเตือนฟิลด์บังคับก่อนส่ง · Sub-task ร่างในฟอร์ม Task ไม่ส่ง Size เมื่อระดับ Sub-task ซ่อน Size

**ต่างจากหน้าจอ / ยังไม่ทำ**
- หน้าจอ v1.0.3 ไม่มีส่วนเลือกหมวด Template, ตัวแก้ชุดฟิลด์ใน Settings / Admin และส่วน "ฟิลด์เพิ่มเติม" ใน Drawer · ทำตามคำสั่งผู้ใช้ 2026-11-09 โดยใช้ส่วนประกอบเดิมของหน้า
- Scrum / Kanban / Waterfall / Blank ใช้ชุดฟิลด์เดียวกับ Development ไปก่อน (ยังไม่มีคำตัดสินให้ต่างกัน) · Template ในตัวของหมวดอื่นยังไม่ทำ (รอคำตัดสิน ดูหัวข้อ 24 พ.ย. ด้านล่าง)
- ~~Import Excel ยังไม่อ่านคอลัมน์ Custom field และไม่ตรวจชุดฟิลด์ตอนนำเข้า · แม่แบบ Excel ของ Workspace ยังเป็นคอลัมน์มาตรฐานชุดเดิม~~ ทำแล้ว 10 พ.ย. + 24 พ.ย. (ดูด้านล่าง)

**Import Excel อ่าน Custom field (10 พ.ย. 2569 · ค้างจากงานนี้)**
- โหมดอัปเดตแผน: หัวคอลัมน์ที่ตรงชื่อ Custom field (หรือ "ชื่อ (Custom)" ของไฟล์ส่งออก) จับคู่อัตโนมัติเป็น `cf:<id>` · เลือกเองในขั้นจับคู่คอลัมน์ได้ (รายการแสดง "ชื่อ (Custom field)")
- ค่าในเซลล์รูปแบบเดียวกับไฟล์ส่งออก: ตัวเลือกใช้ชื่อ (หลายค่าคั่นด้วย ,) · วันที่ · ตัวเลข · คนใช้ชื่อ / อีเมลของสมาชิก · เซลล์ว่าง = ล้างค่า
- ผลตรวจแสดงการเปลี่ยนรายฟิลด์ (`cf:<id>` + ชื่อฟิลด์) · ค่าผิดรูปแบบ = คำเตือนและไม่แตะฟิลด์นั้น · ฟิลด์ที่ซ่อนในระดับนั้นไม่แตะ · Activity `field = cf:<id>` (actor import) · งานใหม่ในไฟล์ได้ค่าด้วย
- โหมดสร้างโปรเจกต์ใหม่ยังไม่มี Custom field ให้จับคู่ (ฟิลด์สร้างหลังมีโปรเจกต์)


**งานค้างที่ปิด (24 พ.ย. 2569 · Owner สั่ง "ทำเลย")**
- Template Excel ของโปรเจกต์: `GET w/import-template.xlsx?project=<key>` (ต้องเห็นโปรเจกต์ · ไม่พบ = 404) คอลัมน์ตามชุดฟิลด์ (ฟิลด์ที่ซ่อนทั้งสองระดับไม่มีคอลัมน์ · QA Due เฉพาะโปรเจกต์แยก Dev / QA · มี Sprint) + คอลัมน์ Custom field ที่ไม่ซ่อนทั้งสองระดับ ชื่อเดียวกับไฟล์ Export จึงจับคู่อัตโนมัติ · สถานะ / Module / Sprint / วันหยุดของโปรเจกต์ · ไม่ระบุโปรเจกต์ = Template ของ Workspace ชุดเดิม (สร้างโปรเจกต์ใหม่ยังไม่มี Custom field ให้จับคู่)
- Export และ Template ของโปรเจกต์: Custom field ชนิดเลือกค่าได้รายการเลือกในเซลล์ (ตัวเลือกอยู่ในชีตค่าที่ใช้ได้) · ชนิดคนใช้รายชื่อสมาชิก · ชีตคำแนะนำมีแถวของแต่ละ Custom field (ชนิดค่า + โหมด Task / Sub-task)
- หน้าเว็บ: ปุ่มดาวน์โหลด Template ในหน้านำเข้า / ส่งออกของโปรเจกต์ส่ง `?project=` · หน้าสร้างโปรเจกต์จาก Excel ใช้ Template ของ Workspace เหมือนเดิม
- Import โหมดอัปเดตแผนตรวจชุดฟิลด์ของโปรเจกต์ (ทั้งฟิลด์มาตรฐานและ Custom field) ตามระดับของแถว (Task / Sub-task):
  - ฟิลด์ที่ซ่อน: งานเดิมไม่แตะค่า (ค่าเดิมยังเก็บไว้) · งานใหม่ไม่ได้ค่านั้น · เตือนแบบสรุป 1 ข้อต่อฟิลด์ต่อระดับ (เฉพาะเมื่อค่าในไฟล์ต่างจากระบบ) ไฟล์ที่ Export แล้วนำเข้ากลับจึงไม่เตือน
  - ฟิลด์บังคับ: ไฟล์ล้างค่าของงานเดิม = คงค่าเดิม + เตือนรายแถว · งานใหม่ที่ว่าง (รวมกรณีไม่มีคอลัมน์ในไฟล์) = ยังสร้างให้ + เตือนแบบสรุป
  - ตัดสินเอง: เป็นคำเตือน ไม่บล็อกทั้งไฟล์ (ต่างจาก API ที่ตอบ `400 missing_required_fields` / `422 field_hidden`) เพราะการนำเข้าเป็นงานทีละมาก ๆ และกติกาเดิมให้ค่าผิดรูปแบบเป็นคำเตือน · Priority ว่างไม่นับ (มีค่าเริ่มต้น)
- Test: `apps/api/test/imports.e2e.test.ts` › "ชุดฟิลด์ตอนนำเข้า และ Template ของโปรเจกต์" 2 กรณี
- ผลตรวจ: `pnpm typecheck` ผ่าน · `apps/api` vitest 70 ไฟล์ 890 ผ่าน / 7 skipped (ฐานข้อมูล `friday_f01`) · `apps/web` vitest 53 ไฟล์ 794 ผ่าน
- NOT_RUN: deploy Docker ในเครื่องและตรวจผ่านเบราว์เซอร์ (Host ทำต่อตามลำดับ)

**Template ของหมวดอื่น: คำถามที่ยังเปิด (ไม่ได้ทำเอง)**
- ไฟล์งานนี้บันทึกว่าผู้ใช้สั่ง "ยังไม่ทำ Template ของหมวดอื่น" และไม่มีคำตัดสินว่าแต่ละหมวด (Service management, Marketing, HR, Finance ฯลฯ) ใช้ฟิลด์ / คอลัมน์ Table / Workflow อะไร จึงไม่สร้าง Template ในตัวของหมวดเหล่านี้เพื่อไม่เดาแทนเจ้าของงาน · Scrum / Kanban / Waterfall / Blank คงชุดฟิลด์เดียวกับ Development
- ตอนนี้ Admin สร้าง Template ขององค์กรในหมวดใดก็ได้อยู่แล้ว (Admin Console › Template · คัดลอกจาก Template ในตัวแล้วปรับชุดฟิลด์) หน้าสร้างโปรเจกต์แสดงหมวดนั้นเมื่อมี Template
- ขอคำตัดสินจาก Owner: (1) หมวดไหนต้องมี Template ในตัว (2) แต่ละหมวดซ่อน / บังคับฟิลด์ไหน คอลัมน์ Table ชุดไหน Workflow ชื่ออะไร (3) Scrum / Kanban / Waterfall ควรต่างจาก Development ไหม เช่น Kanban ซ่อน Size / Sprint

**คำขอนอก lane (24 พ.ย.)**
- `apps/web/app/work/[ws]/import/_components/import-wizard.tsx`, `export-panel.tsx` (lane W14): เพิ่ม `?project=` ในลิงก์ดาวน์โหลด Template 1 บรรทัดต่อไฟล์
- `docs/spec/03-api.md` (D99): แถว `GET w/import-template.xlsx` ควรเพิ่ม `?project=<key>` และกติกาชุดฟิลด์ตอนนำเข้าตามด้านบน · ยังไม่ได้แก้
