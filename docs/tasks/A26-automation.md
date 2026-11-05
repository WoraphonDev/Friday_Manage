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

- [ ] test: dry-run ไม่บันทึก, กฎย้ายสถานะทำงาน, วนซ้ำถูกหยุด
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
