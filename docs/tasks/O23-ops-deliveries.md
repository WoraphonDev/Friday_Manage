# O23 · ประวัติการส่งแจ้งเตือน และรายชื่อไม่ส่งอีเมล

| | |
|---|---|
| Wave | O-4 |
| รอ merge | — |
| Lane (แก้ได้เฉพาะ) | `packages/db/**` (suppression list · เก็บเนื้อหาที่ส่ง 90 วัน) · `apps/api/src/channels/**` (บันทึกคำตอบปลายทาง / bounce) · `apps/ops-api/src/deliveries/**` · `apps/ops-web/app/(console)/deliveries/**` |
| หน้าจอ | `design/canvas/ops/` › Deliveries · Modals-Support (Y6 ดูข้อความที่ส่ง, Y7 เอาอีเมลออกจากรายการไม่ส่ง) |
| สเปก | [06-ops-roles](../spec/06-ops-roles.md) · [05-business-metrics](../spec/05-business-metrics.md) |

อ่าน [README](README.md) ก่อนเริ่ม · ทำเฉพาะสิ่งที่ติดป้าย **เฟส 2** ใน Canvas · **เริ่มเมื่อผู้ใช้สั่งเริ่มเฟส 2** (Canvas: "เริ่มเมื่อมีลูกค้าจ่ายเงินและข้อมูลการใช้งานจริงพอ")

## ทำอะไร

- ทุกข้อความที่ส่งออกนอกแอป (Email, LINE, Webhook) เก็บ 90 วัน · ค้นตามผู้รับ / Workspace · กรองสถานะ (ส่งถึง / ล้ม / ข้ามช่วงงดส่ง / ถูกบล็อก)
- รายละเอียด: คำตอบจากปลายทาง (HTTP code + body ย่อ) · ส่งซ้ำ · ดูข้อความที่ส่ง (Y6) · แนบใน Ticket
- Webhook ล้มครบจำนวนครั้ง → ปิดชั่วคราวและแจ้ง Admin ของ Workspace
- Suppression list: เพิ่มเองเมื่อ bounce ถาวร / รายงานสแปม · เอาออกได้เมื่อลูกค้ายืนยัน (Y7) · API ลูกค้าไม่ส่งอีเมลถึงรายชื่อนี้
- ต้องรับ webhook bounce / complaint จากผู้ให้บริการอีเมล (SES) · ใช้ตัวจำลองในเครื่อง

## เสร็จเมื่อ

- [x] หน้าตรงกับ Canvas ที่ 1440 px · ที่ 390 px ใช้งานได้
- [x] ครบทุกสถานะตาม M1 · ซ่อนปุ่มตามบทบาท · Audit ทุกการแก้
- [x] e2e test ของ API (ข้อมูลสมมติ) + component test ด้วย MSW · typecheck / test / build ผ่าน
- [x] build และ deploy Docker ในเครื่องตาม CLAUDE.md แล้วตรวจ flow ผ่าน container

## ยังต้องตัดสินใจ

- ผู้ให้บริการอีเมลจริง (SES หรืออื่น) ผูกกับการขึ้น AWS (I01)

## บันทึกผล

**10 พ.ย. 2569 · branch `task/O23-deliveries` (ซ้อนบน O21 เพราะใช้ไฟล์กลางของ ops-web ร่วมกัน)**

ฐานข้อมูล (migration 0024)
- `notification_deliveries` เพิ่ม `target_label`, `content` (ที่ผู้รับเห็น + คำขอ HTTP ที่ซ่อน token แล้ว), `response` (HTTP code + body ≤ 500 ตัวอักษร), `log` (ลำดับเหตุการณ์), `resend_requested_at` และสถานะ `suppressed`
- ตารางใหม่ `email_suppressions` (ลบไม่ได้ · เอาออก = `removed_at` + เหตุผล) และ `email_feedback_events` · RLS `ops_only`

API ลูกค้า (`apps/api/src/channels`)
- ทุกการส่งบันทึกสิ่งที่ส่งและคำตอบปลายทาง: Email (SMTP ตอบรับ), Webhook (HTTP code + body), LINE (สถานะจาก LINE API) · URL ของ Webhook เก็บแบบซ่อน path ที่เป็น token และตัด query
- Email ถึงรายชื่อไม่ส่ง → `suppressed` ไม่ retry · Webhook ล้มครบ → ปิดชั่วคราว + แจ้ง Owner / Admin (มีอยู่แล้ว) และลงลำดับเหตุการณ์
- `POST /api/v1/hooks/email-feedback?token=…` รับ bounce / complaint รูปแบบ SES (ห่อด้วย SNS หรือไม่ก็ได้ · SNS ส่ง text/plain จึงเพิ่ม body parser) · bounce ถาวร / รายงานสแปม → ไม่ส่งทันที · bounce ชั่วคราวต่างวันกัน 5 วันใน 7 วัน → ไม่ส่ง · ตีกลับแล้วลงลำดับเหตุการณ์ของการส่งล่าสุด
- token: `EMAIL_FEEDBACK_TOKEN` (production ต้องตั้ง ไม่ตั้ง = 503) · dev / test ใช้ `dev-email-feedback` เป็นตัวจำลองในเครื่อง
- ส่งซ้ำ: ops-api ตั้ง `resend_requested_at` แล้วงาน scan (ทุกนาที) ส่งเข้าคิว · ลบประวัติการส่งและเหตุการณ์ bounce ที่เก่ากว่า 90 วัน ทุกวัน 03:17
- `channels/deliveries` ของ Admin กรอง `status=suppressed` ได้ · OpenAPI อัปเดตแล้ว

ops-api (`src/deliveries`)
- รายการ + สรุป 24 ชม. · ค้นตามผู้รับ / Workspace / Issue key / รหัสการส่ง · กรองช่องทาง (LINE รวมส่วนตัวและกลุ่ม) และสถานะ · เลื่อนหน้าด้วย `before`
- รายละเอียด, ส่งซ้ำ (ลง Audit log ของลูกค้า หมวด notify), แนบใน Ticket (ข้อความภายใน), รายชื่อไม่ส่ง, เอาออก (Y7 · ต้องมีเหตุผล ≥ 5 ตัวอักษร · ลง Audit log)
- สิทธิ์: อ่าน Owner / Support / วิศวกร · วิศวกรเห็นอีเมลแบบซ่อนและค้นด้วยอีเมลไม่ได้ (06 › 2) · แนบ Ticket และเอาอีเมลออก: Owner / Support
- เนื้อหาที่ส่ง (Y6) เห็นเฉพาะ Owner / Support และเมื่อลูกค้าเปิดสิทธิ์ให้ทีม Friday เข้าช่วยเหลือ (support_access_grants ยังไม่หมดอายุ) · ส่วนหัวคำขอและคำตอบเห็นเสมอ

ต่างจาก Canvas
- แผงรายละเอียดเลือกรายการแรกให้เอง และเปิดตรงจากลิงก์ `/deliveries?id=…` (ที่แนบใน Ticket)
- การ์ด "รอส่งหลังช่วงงดส่ง" บอกว่า "ส่งต่อเมื่อพ้นช่วงงดส่งของผู้รับ" แทนเวลาตายตัว เพราะช่วงงดส่งต่างกันรายคน / รายโปรเจกต์
- เพิ่มปุ่ม "โหลดเพิ่ม" ใต้ตาราง และข้อความเตือนเมื่อตอบ 404 ว่าน่าจะถูกลบที่ปลายทาง

ยังไม่ทำ / ต้องทำตอนขึ้น AWS (I01)
- ตรวจลายเซ็นของ SNS และยืนยัน SubscriptionConfirmation อัตโนมัติ (ตอนนี้ log URL ไว้ให้ยืนยันเอง)
- ค้นด้วยเลข Ticket / requestId (Canvas) · ยังไม่มีความเชื่อมโยงระหว่าง Ticket กับการส่ง นอกจากที่แนบเอง
- รายชื่อไม่ส่งใช้กับแจ้งเตือนทางอีเมลเท่านั้น · อีเมลยืนยันตัวตน / ลืมรหัสผ่านยังส่งเสมอ (ผู้ให้บริการอีเมลกันซ้ำอีกชั้น)

Test: `apps/api/test/deliveries.e2e.test.ts` 10 ข้อ · `apps/ops-api/test/deliveries.e2e.test.ts` 10 ข้อ · `apps/ops-web` component test 7 ข้อ (MSW)
