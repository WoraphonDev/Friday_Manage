# A09 · Lead Dashboard และ Reports

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | A08 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/reports/**` · `apps/api/test/reports.e2e.test.ts` |
| หน้าจอ | O1 (`design/canvas/LeadDashboard.dc.html`) · O2 (`design/canvas/Reports.dc.html`) |
| สเปก | 03-api › 3.9 แถว insights, reports |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `GET p/insights/risks`: เลยกำหนด, ใกล้ครบกำหนดแต่ความคืบหน้าต่ำ, คน capacity เกิน (ใช้ `overview/workload.ts`), งานที่ติด Dependency, คำขอเลื่อน Due ที่รอ
- `GET p/insights/modules`: ความคืบหน้า, วันจบที่คาด (จากอัตราเสร็จจริง) เทียบ Milestone / Go-live ของ Module
- `GET p/reports/weekly?week=` · `module-forecast` · `traceability` (FR / Screen → งาน → ผลทดสอบล่าสุด)

## กติกาที่ต้องตรง

- Guest → 403

## เสร็จเมื่อ

- [ ] test ครอบคลุมทุก endpoint ด้วยข้อมูลสมมติที่รู้คำตอบล่วงหน้า
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- ส่งรายงานตามรอบ (A25)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
