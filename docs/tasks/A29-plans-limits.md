# A29 · แพ็กเกจ, ขีดจำกัด (402) และใบเสนอราคา

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | T00 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/billing/**` · `apps/api/test/plans.e2e.test.ts` · `apps/api/src/core/plan-limits.ts` |
| หน้าจอ | Q2 (`design/canvas/PlanLimits.dc.html`) · R2 (`design/canvas/Checkout.dc.html`) · N1 (`design/canvas/AdminConsole.dc.html`) |
| สเปก | 03-api › 3.10 · 03-api › 1 Error (402) · memory ของโปรเจกต์: Free ≤ 5, Team S ≤ 10, M ≤ 25, L ≤ 50, Enterprise · ทุกแพ็กเกจ Team ฟีเจอร์เท่ากัน |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `PlanLimits.assert` จริง: projects, seats (ไม่นับ Guest), storage_bytes → 402 `plan_limit_reached` พร้อม `details` (ขีดจำกัด, ค่าปัจจุบัน, ทางออก)
- Workspace ใหม่ทดลอง Team 14 วัน (`subscription`)
- `GET w/usage` · `GET w/billing` · `GET w/billing/quote?plan&cycle&wht` (VAT 7%, หัก ณ ที่จ่าย 3%) · `GET / PUT w/billing/profile`

## กติกาที่ต้องตรง

- เงินเป็นสตางค์

## เสร็จเมื่อ

- [ ] test: เกินแต่ละประเภทได้ 402 ตามหน้า Q2, quote ถูกต้องทุกกรณี
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- ชำระเงินจริง (A33)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
