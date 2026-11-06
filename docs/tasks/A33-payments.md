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

- [x] test ด้วย Stripe test mode / ตัวปลอม
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

### Endpoint (`apps/api/src/payments/`) · Owner / Admin (`ws.billing`) ยกเว้นที่ระบุ

| Method | Path | หมายเหตุ |
|---|---|---|
| POST | `w/:ws/billing/checkout` | body `{ plan: team_s\|team_m\|team_l, cycle, method: card\|promptpay\|transfer, wht?, poNumber? }` + หัว **`Idempotency-Key`** (8–128 ตัว; ไม่ส่ง → 400 `idempotency_key_required`) · ต้องมีข้อมูลออกใบกำกับภาษี (422 `billing_profile_required`) · `wht` กับบัตร → 422 `wht_not_allowed_for_card` · คืน `{ invoice, payment, card.clientSecret \| promptpay.{qrPayload, expiresAt (15 นาที)} \| transfer.{bank, accountNo, accountName, reference, dueDate (+7 วัน)}, replayed }` |
| GET | `w/:ws/billing/invoices` · `invoices/:id` · `invoices/:id.pdf` | รายการพร้อม `method`, `paymentStatus`, `hasSlip`, `pdfUrl`, `taxDocument`, `whtCertificate`, `whtDueBy` · PDF ใบแจ้งหนี้ (A4, ฟอนต์ IBM Plex Sans Thai) |
| GET | `w/:ws/billing/tax-documents/:id.pdf` | ใบเสร็จรับเงิน / ใบกำกับภาษี |
| POST | `w/:ws/billing/invoices/:id/slip` | multipart `file` (PNG/JPG/WebP/PDF ≤ 5 MB, ตรวจจากไบต์แรก) · ใบแจ้งหนี้ชำระด้วยการโอนเท่านั้น (409 `slip_not_applicable`) · → `pending_review` และ **เปิดแพ็กเกจใหม่ทันที** · แนบใหม่ได้ระหว่างรอตรวจ |
| POST | `w/:ws/billing/invoices/:id/wht-certificate` | multipart `file` · เฉพาะใบแจ้งหนี้ที่หักภาษี (409 `wht_not_applicable`) · ภายใน 30 วันนับจากออกใบ (409 `wht_deadline_passed`) |
| POST | `w/:ws/billing/subscription:cancel` (และ `subscription/cancel`) | Owner · `status = canceled` และใช้แพ็กเกจเดิมต่อถึงสิ้นรอบ (`effectivePlan` ของ A29 เปลี่ยนเป็น Free เมื่อพ้นวันนั้น) · ทดลองใช้ → ถึงวันสิ้นสุดทดลอง |
| POST | `hooks/stripe` | ตรวจ `Stripe-Signature` (`t=…,v1=HMAC-SHA256(secret, "t.rawBody")`, ทนเวลา 5 นาที) · `payment_intent.succeeded` → invoice `paid`, เปิดแพ็กเกจ, ขอออกใบกำกับภาษี · `payment_failed` → payment `rejected` (ใบยัง `open`) · `canceled` (เช่น QR หมดอายุ) → `void` · ซ้ำ → `duplicate`, ไม่รู้จัก → `unknown` (ตอบ 200 เพื่อไม่ให้ Stripe retry) |
| POST | `hooks/etax` | ตรวจ `x-etax-signature: sha256=HMAC(ETAX_WEBHOOK_SECRET, rawBody)` · `{ providerRef, status: issued\|failed }` → `tax_documents` (+ อีเมลแจ้งผู้รับเมื่อ `issued`) |

### โครงสร้าง

- `providers.ts`: interface `PaymentGateway` (Stripe) และ `ETaxProvider` · **`FakeGateway` / `FakeETax`** (ไม่ออกเครือข่าย, ลายเซ็น Webhook ใช้สูตรเดียวกับ Stripe จริง, secret เริ่มต้น `whsec_dev_fake` / `etax_dev_fake`) · `StripeGateway` เรียก REST โดยตรงด้วย `fetch` (ไม่ใช้ SDK) พร้อม `Idempotency-Key` · `HttpETax` ส่ง JSON ไป `ETAX_API_URL` · เลือกจาก env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ETAX_API_URL`, `ETAX_API_KEY`, `ETAX_WEBHOOK_SECRET` · **production ที่ไม่ตั้ง Stripe จะ throw ตอนเริ่ม**
- เลขใบแจ้งหนี้ `FRI-YYMM-NNNN` ออกต่อเนื่องทั้งระบบ (ล็อก advisory ระดับระบบ + นับด้วย `SYSTEM_DB`)
- ใบกำกับภาษี: ชำระสำเร็จ → `tax_documents` (`pending`) → งาน `payments.etax` ส่งไปผู้ให้บริการ (`submitted`) → webhook (`issued` / `failed`)
- ข้อมูลผู้ขาย/บัญชีรับโอนบน PDF อ่านจาก env (`SELLER_NAME`, `SELLER_TAX_ID`, `SELLER_ADDRESS`, `BANK_NAME`, `BANK_ACCOUNT_NO`, `BANK_ACCOUNT_NAME`) · ค่าเริ่มต้นเป็นข้อมูลสมมติ

### คำตัดสินที่เลือกเอง

- **แพ็กเกจ / รอบของใบแจ้งหนี้ และ Idempotency-Key เก็บใน `audit_logs`** (action `billing.checkout`, summary = JSON `{plan, cycle, method, wht, key(sha256), payload(sha256)}`) เพราะ `invoices` ไม่มีคอลัมน์แพ็กเกจ และไม่มีตาราง idempotency (migration อยู่นอก lane) · ใช้ค้นซ้ำ + ตรวจ payload (key เดิมแต่ข้อมูลต่าง → 422 `idempotency_key_reuse`) · ถ้าต้องการให้สะอาดขอ `invoices.plan_code`, `invoices.cycle` และตาราง `idempotency_keys` (ดู "คำขอนอก lane")
- **เขียน `payments` / `invoices` / `subscriptions` ผ่าน `SYSTEM_DB`** หลังตรวจสิทธิ์และเจ้าของใบแจ้งหนี้ด้วย RLS แล้ว: ลูกค้าห้ามตั้งสถานะชำระ / แพ็กเกจเอง และ Webhook ไม่มีผู้ใช้ในบริบท
- บัตรเป็นการชำระรายครั้งต่อใบแจ้งหนี้ (PaymentIntent) **ยังไม่ตัดอัตโนมัติรอบถัดไป** (ต้องใช้ Stripe Billing/Subscription — สเปกยังไม่ระบุ) · ต่ออายุทำด้วย checkout ใหม่
- สลิปเปลี่ยนแพ็กเกจทันทีตาม 03-api · **ใบกำกับภาษีของการโอนออกหลังเจ้าหน้าที่ยืนยัน** (A32 ต้องเรียกการสร้าง `tax_documents` + ส่ง e-Tax แบบเดียวกับ `PaymentsService.settle`)
- PDF วาดด้วย `pdfkit` + ฟอนต์ IBM Plex Sans Thai (ชุด thai/latin ผสมเป็นช่วง) · เพิ่ม dependency `pdfkit`, `@fontsource/ibm-plex-sans-thai`, `@types/pdfkit` ใน `apps/api`

### คำขอนอก lane

- **T00/schema**: `invoices.plan_code`, `invoices.cycle`, `invoices.method` และตาราง `idempotency_keys (workspace_id, key, request_hash, response, created_at)` · ตอนนี้ใช้ `audit_logs` แทน
- **A32 (ops-api)**: ยืนยัน / ปฏิเสธสลิป — `confirm` ต้อง: payment `confirmed`, invoice `paid` + `paid_at`, สร้าง `tax_documents` (`TX-<เลขใบแจ้งหนี้>`) และขอ e-Tax · `reject` ต้องคืนแพ็กเกจเดิมเมื่อไม่มีการชำระอื่น (ตอนนี้ A33 เปิดแพ็กเกจให้ก่อนตามสเปก)
- **`.env.example`**: เพิ่ม `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ETAX_API_URL`, `ETAX_API_KEY`, `ETAX_WEBHOOK_SECRET`, `SELLER_NAME`, `SELLER_TAX_ID`, `SELLER_ADDRESS`, `BANK_NAME`, `BANK_ACCOUNT_NO`, `BANK_ACCOUNT_NAME`
- **I01 (deploy)**: ตั้ง Webhook Stripe ไป `https://<api>/api/v1/hooks/stripe` (events: `payment_intent.succeeded`, `.payment_failed`, `.canceled`) · ตรวจว่า reverse proxy ส่ง body ดิบไม่แก้ไข
- **W19 (R2)**: ใช้ `client_secret` กับ Stripe.js · แสดง QR จาก `promptpay.qrPayload` · poll `GET billing/invoices/:id` จน `paid` · ส่ง `Idempotency-Key` ใหม่ต่อการกดชำระหนึ่งครั้งและใช้ซ้ำเมื่อ retry
- **D99**: เพิ่ม `GET invoices/:id`, ชนิดไฟล์สลิป, รูปแบบ response ของ checkout ใน 03-api 3.10

### ผล test

`apps/api/test/payments.e2e.test.ts` 13 ข้อ (Stripe / e-Tax = ตัวปลอม): เงื่อนไขก่อนชำระ (key, สิทธิ์, โปรไฟล์ภาษี, หัก ณ ที่จ่ายกับบัตร) · บัตร (ยอดและ VAT, เลขใบ, ส่งซ้ำด้วย key เดิมได้ผลเดิม + ไม่สร้างใบซ้ำ, key เดิมข้อมูลต่าง 422, Webhook ลายเซ็นผิด/หมดอายุ/ไม่รู้จัก, ชำระสำเร็จ → paid + เปิด Team M + ใบกำกับภาษี + ส่ง e-Tax, ซ้ำไม่ทำซ้ำ, hooks/etax, รายการ + PDF + Member 403) · PromptPay (QR 15 นาที, รายปี 10 เดือน + หัก 3%, failed → open, canceled → void, ล้มเหลวหลังสำเร็จไม่ย้อน) · โอน (บัญชี + ครบกำหนด 7 วัน, สลิป → pending_review + เปิดแพ็กเกจทันที, ตรวจชนิด/ขนาด/สิทธิ์, แนบใหม่) · 50 ทวิ (เฉพาะที่หักภาษี, 30 วัน, ชนิดไฟล์) · ยกเลิกแพ็กเกจ (Owner, ใช้ได้ถึงสิ้นรอบ, ซ้ำ 409) · เลือก provider จาก env + ตรวจลายเซ็น · `pnpm typecheck` ผ่าน · API 521 ผ่าน (ข้าม 6 = เดิม) · **ยังไม่ได้ทดสอบกับ Stripe test mode จริง** (ไม่มีกุญแจในสภาพแวดล้อมนี้ — `StripeGateway` เขียนตามเอกสาร PaymentIntents REST ควรลองด้วยกุญแจ test ก่อนเปิดใช้)
