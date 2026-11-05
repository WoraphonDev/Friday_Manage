# A33 · ชำระเงิน: บัตร, PromptPay, โอน, ใบกำกับภาษี, 50 ทวิ

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | A29 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/payments/**` · `apps/api/test/payments.e2e.test.ts` · route `hooks/stripe`, `hooks/etax` |
| หน้าจอ | R2 (`design/canvas/Checkout.dc.html`) · N1 (`design/canvas/AdminConsole.dc.html`) |
| สเปก | 03-api › 3.10 · 03-api › 3.11 · docs/tech-stack.md (Stripe + ผู้ให้บริการ e-Tax) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `POST w/billing/checkout` (`Idempotency-Key`): บัตร = Stripe client secret · PromptPay = QR 15 นาที · โอน = ใบแจ้งหนี้
- สลิป, 50 ทวิ, `invoices`, PDF, `subscription:cancel`
- `hooks/stripe`, `hooks/etax` · interface ผู้ให้บริการ e-Tax (ตัวปลอมสำหรับ test)

## กติกาที่ต้องตรง

- ทำหลัง A29 merge · ใช้ service ที่ A29 export จาก `billing/`

## เสร็จเมื่อ

- [ ] test ด้วย Stripe test mode / ตัวปลอม
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
