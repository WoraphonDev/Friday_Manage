# A35b · API: ต่อ Gateway จริง (PromptPay QR + บัตร)

| | |
|---|---|
| Wave | O-1 · **Gateway = Stripe** (Owner เลือก 24 พ.ย. 2569) |
| รอ merge | A35a |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/payments/providers/**` · `apps/api/test/payments-gateway.e2e.test.ts` |
| หน้าจอ | Checkout (4b) · Billing › การ์ดช่องทาง |
| สเปก | [decisions.md](../decisions.md) › "Friday Ops: บทบาทพนักงาน" ข้อ 7 |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน · หน้าจอทั้งหมดของ Friday Ops อยู่ใน `design/canvas/ops/` (สำเนาของ [Canvas Friday Ops](https://claude.ai/artifact/Q8tsmLfQqS1aUJ2rNrkw9r) รุ่นที่ 40) · ทำเฉพาะสิ่งที่ติดป้าย **เฟส 1**

**ก่อนเริ่ม:** ~~ผู้ใช้ต้องเลือก Gateway~~ Owner เลือก **Stripe** แล้ว (24 พ.ย. 2569 · บันทึกใน decisions.md ข้อ 7) · คำแนะนำเดิม: ขอใบเสนอราคา PromptPay จากทั้งสองเจ้า ใกล้กันเลือก Stripe (มีโค้ดอยู่แล้ว) · Opn ถูกกว่าชัดเจนเลือก Opn

## ทำอะไร

- `PaymentProvider` ของเจ้าที่เลือก: สร้าง PromptPay QR (ผูกยอดและใบแจ้งหนี้ · หมดอายุ 15 นาที), ตัดบัตรตามรอบ (ล้มแล้วลองใหม่วันที่ 1, 3, 5), 3-D Secure
- webhook: ตรวจลายเซ็น, กันประมวลผลซ้ำ, ปิดใบแจ้งหนี้ ต่ออายุ และออกเอกสาร · จ่ายซ้ำแล้วปิด QR เก่าและส่งเข้าคิว
- ดึงรายการย้อนหลังทุกเช้าเพื่อกระทบยอด (ใช้โครงจาก A35a)
- ตั้งค่าผ่าน environment (คีย์ทดสอบใน dev · ห้าม commit คีย์)

## เสร็จเมื่อ

- [x] test ด้วย payload webhook ตัวอย่างของผู้ให้บริการ (รูปแบบ event ของ Stripe เซ็นด้วย `stripe.webhooks.generateTestHeaderString` · ไม่ออกเครือข่าย)
- [ ] ทดสอบกับ sandbox ของผู้ให้บริการในเครื่อง · **NOT_RUN**: Owner ยังไม่ได้ให้คีย์ทดสอบ (`sk_test_…`) และ `whsec_…` ของ Stripe · ยังไม่ได้ลองกับ Stripe test mode จริง
- [x] `pnpm --filter @friday/api typecheck test` ผ่าน (รันแยกเป็น `typecheck` แล้ว `test` เพราะ pnpm ส่ง `test` ไปเป็นอาร์กิวเมนต์ของ tsc)

## ไม่อยู่ในงานนี้

- Bill Payment ผ่านธนาคาร และ Slip API (เฟส 2 · เพิ่มเมื่อมีลูกค้าองค์กรที่ต้องใช้ / สลิปเกินราว 50 ใบต่อเดือน)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

**ส่งงาน 2026-11-24** · Gateway = **Stripe** (Owner เลือก 24 พ.ย. 2569) · test `apps/api/test/payments-gateway.e2e.test.ts` 15 ข้อ · API ทั้งชุด 903 ผ่าน / ข้าม 7 (เดิม) · typecheck ผ่าน · ฐานข้อมูลทดสอบ `friday_a35b`

**ที่ทำ** (`apps/api/src/payments/providers/`)

- `stripe.ts` · `StripeGateway` ใช้ SDK ทางการ `stripe@23.2.0` (แทน REST เดิมของ A33 · ได้ตรวจลายเซ็น / แบ่งหน้า / retry เครือข่ายจาก SDK)
  - PromptPay: PaymentIntent `confirm=true` ผูกยอด (สตางค์) + `metadata.invoice_id / invoice_number` · Stripe ไม่ส่งเวลาหมดอายุของ QR มา จึงคิดเอง = เวลาสร้าง + 15 นาที
  - บัตร: PaymentIntent ผูก Customer + `setup_future_usage=off_session` (เก็บบัตรไว้ตัดรอบถัดไป) + `request_three_d_secure=automatic` (3-D Secure ตามที่ธนาคารขอ ยืนยันด้วย Stripe.js ด้วย `clientSecret` เดิม)
  - ขอ client secret / QR ซ้ำ: ดึง intent เดิมด้วยเลขอ้างอิง ไม่สร้างใหม่ (Idempotency-Key ของ Stripe หมดอายุใน 24 ชม. · เดิมเปิดหน้าชำระวันถัดไปจะได้ intent ใหม่ที่ระบบไม่รู้จัก)
  - `chargeSaved` ตัดแบบ off_session ด้วยบัตรของรายการที่ชำระสำเร็จล่าสุดของ Customer (ไม่ใช่บัตรที่ผูกล่าสุด) · `cancel` · `closeExpiredQr` · `listSettled` (กระทบยอด ใช้ auto-pagination จำกัด 2,000 รายการต่อรอบ)
  - Webhook: `stripe.webhooks.constructEvent` ทนเวลา 5 นาที ตรวจก่อนอ่านเนื้อหาและก่อนเขียนฐานข้อมูล · secret ว่างไม่ยอมรับ · error ส่งต่อเฉพาะชนิด / รหัส / ข้อความของ Stripe (ไม่มีข้อมูลบัตร ไม่มีคีย์)
- `stripe-event.ts` · แปลง event: `canceled` ที่ `cancellation_reason` = `abandoned` (QR หมดอายุ) / `duplicate` (ถูกแทนด้วย QR ใหม่) → `payment.expired` (ใบยังเปิด) · เหตุอื่นยัง void ตาม A33 · อ่านยอดที่รับจริง, Customer, รหัสที่ล้ม
- `card-retry.ts` · ตัดวันที่ 0 ของรอบใหม่ แล้วลองใหม่วันที่ 1, 3, 5 (รวม 4 ครั้ง) · QR 15 นาที
- `gateway-jobs.ts` (`GatewayJobs`)
  - `payments.card-renewal` ทุกวัน 07:00 (หลังกระทบยอด 06:00): Workspace บัตรที่รอบจบแล้วและมี `stripe_customer_id` → ออกใบต่ออายุด้วย `PaymentsService.checkout` (ราคา / คูปองที่ได้ต่อ / เครดิต / VAT เหมือนกดเอง · key `renew:<sub>:<วันจบรอบ>` = 1 ใบต่อรอบ) → ตัด off_session · แต่ละครั้งมี Idempotency-Key ของตัวเอง + advisory lock กันตัดซ้ำ · บันทึก `billing.card_charge_attempt` / `card_charge_failed` · ไม่ผ่านอีเมลแจ้งวันลองใหม่ · ครบ 4 ครั้ง → `billing.card_renewal_failed` + อีเมลลิงก์ชำระ (`/work/:ws/billing/invoices/:id`) · ธนาคารขอ 3-D Secure → `billing.card_action_required` + อีเมลลิงก์ แล้วหยุดตัดเอง · ผลจากคำขอไม่ปิดใบ รอ Webhook เสมอ
  - `payments.qr-expire` ทุก 5 นาที: QR ที่ครบ 15 นาทีปิดที่ Stripe (`abandoned`) → รายการ `rejected` + `billing.qr_expired` · ใบยังเปิด ลูกค้ากดสร้าง QR ใหม่ได้
- `qr-expiry.ts` · ปิดรายการ QR (ใช้ทั้งงานกวาดและ Webhook · เรียกซ้ำได้)

**Webhook / จ่ายซ้ำ** (แก้ใน `payments.service.ts` · นอก lane)

- กันประมวลผลซ้ำ: `settle` ล็อกต่อใบแจ้งหนี้ (advisory lock) แล้วอ่านสถานะใหม่ในธุรกรรม · event ซ้ำ / หลาย event พร้อมกัน / Webhook ชนกับงานกระทบยอด → ปิดใบ ต่ออายุ ออกเอกสาร และส่ง e-Tax ครั้งเดียว (test ยิง 3 event พร้อมกัน)
- ยอดที่ Stripe รับไม่ตรงกับรายการ → `amount_mismatch` ไม่เปิดแพ็กเกจ
- จ่ายอีกครั้ง (`pay` + `renew`): ปิด QR เดิมที่ Stripe (`duplicate`) · ถ้า QR เดิมยังจ่ายเข้ามา: ใบชำระแล้ว → บันทึกเป็นรายการของใบเดิมและเข้าคิว `double_payment` (เดิมทิ้งเป็น "ไม่รู้จัก") · ใบยังเปิด → ปิดใบด้วยรายการนั้นและปิด QR ปัจจุบัน · audit `billing.payment_adopted`
- บัตรชำระสำเร็จ → เก็บ `subscriptions.stripe_customer_id` จาก event (ใช้ตัดรอบถัดไป · ไม่เก็บข้อมูลบัตร)
- checkout บัตรส่ง Customer เดิมไปด้วย ให้บัตรใบใหม่อยู่ที่เดียวกับที่ตัดรอบถัดไป

**ตั้งค่า** (env เท่านั้น · ไม่มีค่าใน repo): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (มีคีย์แต่ไม่มี secret → ไม่ยอมเริ่ม), `STRIPE_API_URL` (ไม่บังคับ · stripe-mock / test · production ห้ามตั้ง), `PAYMENT_GATEWAY=fake` (staging เดิม) · event ที่ต้องตั้งใน Dashboard: `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled` → `https://<api>/api/v1/hooks/stripe`

**Test** (ไม่ออกเครือข่าย): `StripeGateway` ตัวจริงคุยกับตัวจำลอง API ของ Stripe ใน test (HTTP ในเครื่อง · รูปแบบคำขอ / คำตอบ / error 402 `card_error` ตามเอกสาร Stripe) · Webhook เป็น event รูปแบบ Stripe เซ็นด้วย `generateTestHeaderString` · ครอบคลุม: env, ตารางลองใหม่, QR ผูกยอด + 15 นาที + ส่งซ้ำได้รายการเดิม, QR หมดอายุ, จ่ายซ้ำ 3 แบบ, ลายเซ็นผิด 4 แบบไม่เขียนฐานข้อมูล, กันซ้ำพร้อมกัน, ยอดไม่ตรง, บัตรเก็บ Customer + 3DS, ตัดตามรอบล้มวันที่ 0/1/3 ผ่านวันที่ 5, ล้มครบ 4 ครั้ง, 3-D Secure ตอนตัดรอบ, กระทบยอดแบ่งหน้า

**คำตัดสินที่เลือกเอง**

- ตีความ "ลองใหม่วันที่ 1, 3, 5" = ตัดครั้งแรกวันจบรอบ (วันที่ 0) แล้วลองวันที่ 1, 3, 5 นับจากวันเริ่มใบต่ออายุ · ครบแล้วหยุดตัดเอง ใบค้าง `open` ให้การตามหนี้ / ระงับเดิม (C6) ทำต่อ
- ใบต่ออายุออกผ่าน `checkout` ด้วยสิทธิ์ของ Owner (ต้องใช้ RLS ของ Workspace) แต่ audit ของใบบันทึก actor เป็นระบบ (`checkout(..., { actor: { kind: 'system' } })`) · มี `billing.card_renewal_invoice` บอกว่าระบบเป็นผู้ออก
- Workspace ที่ตั้งลดแพ็กเกจไว้ (`pending_plan_id`) ยังไม่ตัด จนกว่างานของ ops-api เปลี่ยนแพ็กเกจให้ (ไม่งั้น checkout จะล้างการลดแพ็กเกจที่ตั้งไว้)
- QR หมดอายุไม่ void ใบ (ต่างจาก A33 ที่ `canceled` → void) เพราะหน้าชำระมีปุ่มสร้าง QR ใหม่ในใบเดิม · ยกเลิกด้วยเหตุอื่นยัง void เหมือนเดิม
- ใช้ SDK `stripe` แทน `fetch` (dependency ใหม่ใน `apps/api` · lockfile เพิ่ม 1 แพ็กเกจ)
- จำนวนครั้งที่ตัด / สถานะหยุดตัด เก็บใน `audit_logs` (ไม่มีตารางให้ · schema อยู่นอก lane)

**คำขอนอก lane** (แก้เท่าที่จำเป็น)

- `apps/api/src/payments/payments.service.ts`: ส่ง `customerRef` / `providerRef`, ปิด QR เดิมตอน renew, ล็อก + อ่านสถานะใหม่ใน `settle`, `adopt` รายการเดิม, ตรวจยอด, `payment.expired`, เก็บ `stripe_customer_id`
- `apps/api/src/payments/providers.ts`: interface (`chargeSaved`, `cancel`, `closeExpiredQr`, ช่องใหม่ของ request / event) + `FakeGateway` รองรับครบ · ย้าย `StripeGateway` / `parseStripeEvent` ไป `providers/` (re-export ชื่อเดิม) · `gatewayFromEnv` ตรวจ secret / `STRIPE_API_URL`
- `apps/api/src/payments/payments.module.ts`: ลงทะเบียน `GatewayJobs`
- `apps/api/openapi.json`: สร้างใหม่ (`hooks/stripe` ตอบ `expired` ได้)
- `apps/api/package.json`, `pnpm-lock.yaml`: `stripe@23.2.0`
- `.env.example`: ชื่อ env ของ Stripe (ไม่มีค่า) · `infra/vps/compose.yml`: แก้คอมเมนต์ (มีชื่อ env ครบแล้ว)
- `docs/decisions.md` ข้อ 7: บันทึกว่าเลือก Stripe (ผู้ใช้สั่ง) · **D99**: `docs/tasks/README.md` บรรทัด "A35b รอผู้ใช้เลือกผู้ให้บริการ" ควรอัปเดต · 03-api `hooks/stripe` เพิ่มผล `expired` และพฤติกรรม QR หมดอายุ
- **W19 / W22b**: หน้าชำระควรแสดง "QR หมดอายุ" เมื่อ `expiresAt` ผ่านแล้ว (QR ที่ปิดแล้วคืน `qrPayload` ว่าง) · หน้าใบแจ้งหนี้ต้องยืนยันบัตรด้วย Stripe.js (`confirmCardPayment(clientSecret)`) สำหรับลิงก์ 3-D Secure / ตัดไม่ผ่าน
- **O03 / Ops**: ปุ่ม "ส่งลิงก์จ่าย" อ่าน `billing.card_renewal_failed` / `card_action_required` ได้

**แก้ตามรีวิว (2026-11-24 · "Close Stripe payment races and audit gaps")** · test ไฟล์นี้ 23 ข้อ (ใหม่ / แก้ 10 ข้อ ล้มทั้งหมดกับโค้ดก่อนแก้)

- สร้าง QR ใหม่ (`pay` + `renew`): ต่อคิว `settle:` แล้วเขียนทับเฉพาะเมื่อใบยังเปิดและแถวยังเป็น QR เดิมที่ไม่ยืนยัน / ไม่ติดคิวผิดปกติ · Webhook ของ QR เดิมยืนยันระหว่างรอ Stripe → ปิด QR ใหม่ที่ Stripe + 409 `invoice_closed` · กดซ้อนกันแล้วอีกคำขอแซง → ปิด QR ของตัวเอง ตอบ QR ปัจจุบัน · รายการที่ติดคิวผิดปกติสร้าง QR ใหม่ไม่ได้ (409 `payment_under_review`) · เลือกแก้แถวเดิมแบบมีเงื่อนไขแทนการเพิ่มแถวต่อ QR เพราะโค้ดหลายจุดถือ "รายการล่าสุดของใบ" เป็นรายการปัจจุบัน (เล็กกว่าและปลอดภัยพอ)
- Webhook ล้มเหลว / ยกเลิก: ต่อคิว `settle:` และเขียน `rejected` เฉพาะแถวที่ยังไม่ยืนยัน (และเลขอ้างอิงตรง) · ไม่เขียน → ตอบ `ignored`
- ตัดบัตรแล้วผู้ให้บริการผิดพลาด (ไม่ใช่บัตรถูกปฏิเสธ): บันทึก `billing.card_charge_failed` ทุกครั้ง ไม่อีเมลลูกค้า · ครั้งสุดท้าย → `billing.card_renewal_failed` + อีเมลลิงก์ชำระ
- ใบต่ออายุ: audit ของ checkout เป็นระบบ · ไม่มี Owner → `billing.card_renewal_blocked` (รอบละครั้ง) + log เตือน · **ยังไม่มีช่องแจ้งทีม Ops จาก API ลูกค้า** (`system_alerts` รับเฉพาะ `error_rate` · ต้องเพิ่ม kind ด้วย migration นอก lane) → Ops อ่าน audit นี้ได้
- ตัดรอบถัดไปด้วยบัตรของรายการที่ชำระสำเร็จล่าสุดของ Customer (เดิมใช้บัตรที่ผูกล่าสุด)
- ตรวจสกุลเงิน `thb` ทั้ง Webhook / กระทบยอด / adopt · ไม่ใช่บาท → `amount_mismatch`
- กระทบยอด: รายการที่ไม่รู้จักแต่ metadata มี `invoice_id` ของเรา → `adopt` เหมือน Webhook (จ่ายซ้ำ / ปิดใบ แทน "ไม่รู้จัก")
- `STRIPE_API_URL` ห้ามใช้กับคีย์ `sk_live_` / `rk_live_` แม้ไม่ใช่ production

**NOT_RUN / ค้าง**

- ยังไม่ได้ทดสอบกับ Stripe test mode จริง: ต้องได้ `sk_test_…` และ `whsec_…` (จาก `stripe listen`) จาก Owner · ควรลอง: PromptPay test QR, บัตร 3DS `4000 0027 6000 3184`, ตัด off_session ด้วย `4000 0000 0000 0341` (ตัดไม่ผ่านหลังเก็บบัตร) · ต้องเปิด PromptPay ในบัญชี Stripe (บัญชีไทย)
- Stripe PromptPay อาจมีเวลาหมดอายุฝั่ง Stripe เอง (SDK ไม่ระบุ) · ระบบปิดเองที่ 15 นาทีอยู่แล้ว ควรยืนยันตอนทดสอบจริง
