# A02 · Checklist, Acceptance criteria และ Dependency

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | — เริ่มได้เลย |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/issue-parts/**` · `apps/api/test/issue-parts.e2e.test.ts` |
| หน้าจอ | C (`design/canvas/TaskDetail.dc.html`) · D (`design/canvas/SubtaskModal.dc.html`) · K1 (`design/canvas/IssueCreate.dc.html`) · 5 (`design/canvas/Gantt.dc.html`) |
| สเปก | 03-api › 3.7 แถว `i/checklist`, `i/dependencies` · 01-entities › F `checklist_item`, `issue_dependency` |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `CRUD + reorder w/{ws}/issues/{key}/checklist` · `kind` = checklist หรือ acceptance · ติ๊กแล้วเก็บ `done_by`, `done_at`
- `GET / POST / DELETE …/dependencies` body `{ predecessorKey | successorKey, type: FS|SS|FF|SF, lagDays }` · ตอบ `{ blockedBy, blocking }` พร้อมสถานะและวันที่ของอีกฝั่ง
- บันทึก `activities` ทุกครั้ง · Event `issue.updated` (`fields: ["checklist"]` หรือ `["dependencies"]`)

## กติกาที่ต้องตรง

- ต้องมี `issue.edit`
- Dependency ต้องอยู่โปรเจกต์เดียวกัน · วนรอบ (A → B → A ทุกความยาว) → 409 `dependency_cycle`
- ตอบ `warnings: dependency_date_conflict` เมื่องานที่ต้องรอเริ่มก่อนงานที่รอจบ (FS)

## เสร็จเมื่อ

- [ ] test ครอบคลุมทุกข้อ รวมวนรอบ 3 งาน
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- Auto-schedule (A07)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
