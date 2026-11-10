# O24 · ส่งประกาศถึงลูกค้าที่เลือก

| | |
|---|---|
| Wave | O-4 |
| รอ merge | O23 |
| Lane (แก้ได้เฉพาะ) | `apps/ops-api/src/announcements/**` · `apps/ops-web/app/(console)/workspaces/**` (เลือกหลายแถว) · `apps/web/src/features/announcements/**` |
| หน้าจอ | `design/canvas/ops/` › Modals-Customers (C8 ส่งประกาศถึงลูกค้าที่เลือก) · Promotions (ส่วนประกาศ) |
| สเปก | [06-ops-roles](../spec/06-ops-roles.md) · [05-business-metrics](../spec/05-business-metrics.md) |

อ่าน [README](README.md) ก่อนเริ่ม · ทำเฉพาะสิ่งที่ติดป้าย **เฟส 2** ใน Canvas · **เริ่มเมื่อผู้ใช้สั่งเริ่มเฟส 2** (Canvas: "เริ่มเมื่อมีลูกค้าจ่ายเงินและข้อมูลการใช้งานจริงพอ")

## ทำอะไร

- เลือกหลาย Workspace ในรายชื่อลูกค้า → ส่งประกาศถึง Owner และ Admin (แสดงจำนวนคน) · ช่องทาง อีเมล / แบนเนอร์ในแอป / ทั้งสอง
- ตั้งเวลาส่ง · ดูตัวอย่างก่อนส่ง · บันทึกใน Audit และประวัติการส่ง (O23)
- แบนเนอร์ในแอปลูกค้าปิดได้ต่อคน · ไม่ส่งถึงรายชื่อไม่ส่งอีเมล

## เสร็จเมื่อ

- [ ] หน้าตรงกับ Canvas ที่ 1440 px · ที่ 390 px ใช้งานได้
- [ ] ครบทุกสถานะตาม M1 · ซ่อนปุ่มตามบทบาท · Audit ทุกการแก้
- [ ] e2e test ของ API (ข้อมูลสมมติ) + component test ด้วย MSW · typecheck / test / build ผ่าน
- [ ] build และ deploy Docker ในเครื่องตาม CLAUDE.md แล้วตรวจ flow ผ่าน container

## ยังต้องตัดสินใจ

- ไม่มี

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน -->
