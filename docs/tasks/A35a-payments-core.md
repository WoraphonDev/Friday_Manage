# A35a · API: แกนการชำระเงิน (ไม่ขึ้นกับผู้ให้บริการ)

| | |
|---|---|
| Wave | O-1 · เริ่มได้ทันทีหลัง O00 |
| รอ merge | O00 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/payments/**` · `apps/api/test/payments-core.e2e.test.ts` |
| หน้าจอ | Checkout (4b) · Billing › กรณีผิดปกติ, รายการเงินเข้า, ใบแจ้งหนี้ |
| สเปก | [decisions.md](../decisions.md) › SaaS และ "Friday Ops: บทบาทพนักงาน" ข้อ 7–9 |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน · หน้าจอทั้งหมดของ Friday Ops อยู่ใน `design/canvas/ops/` (สำเนาของ [Canvas Friday Ops](https://claude.ai/artifact/Q8tsmLfQqS1aUJ2rNrkw9r) รุ่นที่ 40) · ทำเฉพาะสิ่งที่ติดป้าย **เฟส 1**

## ทำอะไร

- ใบแจ้งหนี้และยอดชำระ: ก่อน VAT, VAT, หัก ณ ที่จ่าย 3% (ลูกค้าเปิดตัวเลือกก่อนจ่าย · ใช้ไม่ได้กับบัตร), ส่วนลด, เครดิต
- **สถานะ VAT ของบริษัทเป็นการตั้งค่า** (`billing.vat_registered`): จดแล้ว = คิด VAT 7% และออกใบกำกับภาษี / e-Tax · ยังไม่จด = ไม่คิด VAT และออกใบเสร็จ · test ทั้งสองแบบ
- โอนเงินและอัปโหลดสลิป: ช่วงแรก**ให้ทีมตรวจเอง** (ยังไม่มี Slip API) · เข้าคิวกรณีผิดปกติพร้อม `exception_reason` · ตรวจสลิปซ้ำจากเลขอ้างอิง
- กรณีผิดปกติ 7 แบบตามหน้าจอ: ยอดไม่ตรง / หัก ณ ที่จ่ายไม่ได้แจ้ง, สลิปซ้ำ, ชื่อผู้โอนไม่ตรง, เงินเข้าไม่มีใบแจ้งหนี้, จ่ายซ้ำ, 50 ทวิ, ตรวจสลิปไม่ได้
- `PaymentProvider` interface (ต่อยอดจาก `providers.ts`): สร้าง QR, ตัดบัตร, รับ webhook, ดึงรายการย้อนหลัง · **ตัวจำลอง** ที่ใช้ใน test และ dev ได้ครบทุกเส้นทาง
- โครงกระทบยอด: รับรายการจากผู้ให้บริการแล้วจับคู่กับใบแจ้งหนี้ · รายการที่จับคู่ไม่ได้เข้าคิว

## เสร็จเมื่อ

- [x] test ครอบคลุมทุกข้อ รวมทั้งแบบจด VAT และไม่จด VAT · ใช้ตัวจำลองผู้ให้บริการ
- [x] `pnpm --filter @friday/api typecheck test` ผ่าน
- [x] ไม่มีโค้ดผูกกับผู้ให้บริการรายใด นอกจากตัวจำลองและ Stripe เดิม

## ไม่อยู่ในงานนี้

- ต่อ Gateway จริง (A35b) · Bill Payment และ Slip API (เฟส 2)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

**ส่งงาน 2026-11-09** · test `apps/api/test/payments-core.e2e.test.ts` (7 ข้อ) · API ทั้งชุด 631 ผ่าน · ops-api 32 ผ่าน

- **สถานะ VAT**: env `VAT_REGISTERED` (ค่าเริ่มต้น = จดแล้ว · `false` = ยังไม่จด) อ่านใน `config.vatRegistered` · `GET billing/quote` คืน `vatRegistered` และ `documentType` (`tax_invoice_receipt` / `receipt`) ให้หน้า Checkout แสดงชื่อเอกสารให้ถูก · ยังไม่จด: ไม่คิด VAT, ออกใบเสร็จเลข `RC-…` สถานะ `issued` ทันที ไม่ส่ง e-Tax และงานกวาด e-Tax ข้ามใบเสร็จ
- **สลิป**: `POST invoices/:id/slip` รับช่อง `amount` (สตางค์, ไม่บังคับ) ยอดที่ลูกค้าโอนจริง · ทุกสลิปยัง `pending_review` ให้ทีมตรวจเอง และระบบติด `exception_reason` เพิ่มดังนี้:
  - `duplicate_slip`: ไฟล์เดียวกัน (sha256) เคยแนบกับใบแจ้งหนี้อื่นในทุก Workspace · **ไม่เปิดแพ็กเกจระหว่างรอตรวจ**
  - `wht_not_declared`: ใบไม่มีหัก ณ ที่จ่าย แต่ยอดเท่ากับหัก 3% แล้ว
  - `amount_mismatch`: ยอดต่างเกิน 1 บาท
  - แนบสลิปใหม่จะคำนวณเหตุผิดปกติใหม่
- **จ่ายซ้ำ**: เงินเข้าสำเร็จของใบที่ `paid` แล้วด้วยรายการอื่น → `double_payment` ไม่ยืนยันซ้ำและไม่ออกเอกสารซ้ำ · รายการที่ติดเหตุผิดปกติแล้ว Webhook ที่มาทีหลังจะไม่ยืนยันทับ (รอทีมตัดสินใน O03)
- **กระทบยอด**: `PaymentGateway.listSettled(since)` (ตัวจำลองใช้ `FakeGateway.settled` · Stripe เดิมดึง `payment_intents`) · งาน `payments.reconcile` ทุกวัน 06:00 ย้อน 3 วัน: Webhook หลุด → ยืนยันให้ · ยอดไม่ตรง → `amount_mismatch` · เลขอ้างอิงที่ไม่รู้จัก → คืนใน `unmatched` และเขียน log (ยังสร้างแถว payment ไม่ได้เพราะต้องมีใบแจ้งหนี้ · คิว "เงินเข้าไม่มีใบแจ้งหนี้" จะต่อจากรายการเงินเข้าของธนาคารใน O03)
- ยืนยันด้วย Webhook / กระทบยอด บันทึก `verified_by = 'webhook'` · ทีมยืนยันใน ops-api บันทึก `'staff'`
- เหตุผิดปกติที่ต้องให้คนดู (`payer_name_mismatch`, `wht_certificate`, `unreadable_slip`) ไม่มีทางตรวจอัตโนมัติจนกว่าจะมี Slip API (เฟส 2) · พนักงานติดเองในคิวของ O03
- **นอก lane** (จำเป็นสำหรับสถานะ VAT): `apps/api/src/config.ts`, `billing/catalog.ts` (`computeQuote` รับ `vatRegistered`), `billing/billing.service.ts` (quote) และ `apps/ops-api/src/payments/ops-payments.service.ts` (ยืนยันสลิปออกใบเสร็จเมื่อยังไม่จด VAT · ใช้ env `VAT_REGISTERED` ค่าเดียวกัน)
- ค้าง: สถานะ VAT จริงรอผู้ทำบัญชี · Gateway จริงใน A35b
