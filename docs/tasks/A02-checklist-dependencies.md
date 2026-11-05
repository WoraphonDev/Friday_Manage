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

- [x] test ครอบคลุมทุกข้อ รวมวนรอบ 3 งาน
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- Auto-schedule (A07)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

- เพิ่ม `GET / POST i/checklist`, `GET / PATCH / DELETE i/checklist/{id}` และ `POST i/checklist/reorder` (รับ `i/checklist:reorder` ด้วย) · list ตอบ `{ items }`, กรอง `?kind=checklist|acceptance` ได้ · reorder รับ `{ ids, kind? }` เป็นรายการครบชุดของหมวดที่เลือก หรือทุกหมวดเมื่อไม่ส่ง `kind`
- รายการใหม่ต่อท้ายหมวด · ติ๊กเสร็จเก็บผู้ทำและเวลา ติ๊กซ้ำคงข้อมูลเดิม เอาติ๊กออกล้างทั้งสองค่า · ล็อกแถวงานระหว่างเพิ่ม/แก้/ลบ/จัดลำดับ ป้องกันลำดับชนกัน
- เพิ่ม `GET / POST / DELETE i/dependencies` · POST/DELETE รับคู่เชื่อมด้วย `predecessorKey` หรือ `successorKey` อย่างใดอย่างหนึ่ง · POST มี `type=FS` และ `lagDays=0` เป็นค่าเริ่มต้น · ตอบ `{ blockedBy, blocking }` แต่ละรายการเป็นข้อมูลงานอีกฝั่ง (`key`, `title`, `status`, วันแผน/วันจริง) พร้อมชนิด, lag และ key ของทั้งคู่ · ไม่แสดงปลายทางที่ถูกลบ
- ล็อกกราฟของโปรเจกต์ด้วย transaction advisory lock ก่อนตรวจ/เพิ่ม/ลบ Dependency กันวงรอบแม้คำขอเข้าพร้อมกัน · ตรวจวงรอบด้วยการเดินกราฟ ไม่จำกัดความยาว · ห้ามข้ามโปรเจกต์และ Workspace
- คำตัดสิน: FS เตือนเมื่อวันเริ่มของปลายทางก่อนวันจบต้นทางบวก lag (ไม่นับวันที่เท่ากันเป็น conflict) · lag บวก/ลบนับวันทำการตามปฏิทินโปรเจกต์รวมวันหยุด · เตือนอย่างเดียว ไม่เปลี่ยนวันที่ · ปฏิทินที่ไม่มีวันทำการตอบ 422 และ rollback ทั้งคำขอ
- ทุก endpoint ตรวจ `issue.edit` ภายใต้ `TenantDb.run` · Guest Viewer แก้ไม่ได้แม้ปรับ L2 · โปรเจกต์ที่เก็บถาวรอ่านได้แต่เขียนไม่ได้ · บันทึก activity และส่ง `issue.updated` หลัง commit ทุกการเปลี่ยนแปลง (Dependency บันทึกและส่งให้ทั้งสองงาน)
- ผลตรวจหลัง rebase บน main: `pnpm typecheck`, `pnpm --filter @friday/api build`, `pnpm test` ผ่าน · web 31, DB 105, API 68 tests ผ่าน (API มี 2 tests เดิมที่ skip) · ชุดใหม่ 14 tests ใน `issue-parts.e2e.test.ts` ครอบคลุม CRUD/reorder, completion, ทุกชนิด/ทิศทางของ Dependency, warning, วงรอบสามงานรวมคำขอพร้อมกัน, สิทธิ์/Guest/RLS, ข้ามโปรเจกต์, งานที่ลบ, archived และ rollback/visibility ของ Event หลัง commit · ใช้ฐานทดสอบแยก `friday_a02`
- คำขอนอก lane: `GET i/` ตามสเปกควรรวม Checklist และ Dependency แต่ `IssuesService.get` เป็น lane ของ A03 และปัจจุบันยังไม่รวม · งานนี้ไม่แก้ไฟล์กลาง หน้า Drawer สามารถเรียก dedicated endpoints ที่เพิ่มได้โดยตรง หรือเพิ่ม aggregate integration ภายหลัง
