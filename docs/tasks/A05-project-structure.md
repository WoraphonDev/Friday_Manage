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

- [ ] test ครอบคลุมทุกข้อ รวมเพิ่มวันหยุดแล้ว Plan End เลื่อน
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- สมาชิกโปรเจกต์ (A04)
- Repository (A27)
- แจ้งเตือนโปรเจกต์ (A25)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
