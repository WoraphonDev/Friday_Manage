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

- [ ] หน้าตรงกับ Canvas ที่ 1440 px · ที่ 390 px ใช้งานได้
- [ ] ครบทุกสถานะตาม M1 · ซ่อนปุ่มตามบทบาท · Audit ทุกการแก้
- [ ] e2e test ของ API (ข้อมูลสมมติ) + component test ด้วย MSW · typecheck / test / build ผ่าน
- [ ] build และ deploy Docker ในเครื่องตาม CLAUDE.md แล้วตรวจ flow ผ่าน container

## ยังต้องตัดสินใจ

- ผู้ให้บริการอีเมลจริง (SES หรืออื่น) ผูกกับการขึ้น AWS (I01)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน -->
