# O11 · ops-web: Workspaces, รายละเอียดลูกค้า และผู้ใช้

| | |
|---|---|
| Wave | O-3 |
| รอ merge | O10, O02 |
| Lane (แก้ได้เฉพาะ) | `apps/ops-web/app/(console)/{workspaces,users}/**` · `apps/ops-web/messages/th/customers.json` |
| หน้าจอ | Customers · CustomerDetail · Users · Modals-Customers (C1–C7, C10–C12) |
| สเปก | 03-api › 3.12 · [06-ops-roles](../spec/06-ops-roles.md) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน · หน้าจอทั้งหมดของ Friday Ops อยู่ใน `design/canvas/ops/` (สำเนาของ [Canvas Friday Ops](https://claude.ai/artifact/Q8tsmLfQqS1aUJ2rNrkw9r) รุ่นที่ 40) · ทำเฉพาะสิ่งที่ติดป้าย **เฟส 1**

## ทำอะไร

- รายชื่อและตัวกรอง · รายละเอียด 9 แท็บ รวมการ์ดกำไรและสัญญาณพร้อมอัปเกรด
- การกระทำทุกปุ่มเปิด Modal ตาม C1–C7, C10–C12 · เข้าบัญชีแบบอ่านอย่างเดียวพร้อมแถบด้านบน (G11) · ตัวเลือกโหมดแก้ไขแสดง "ยังไม่เปิด"
- ผู้ใช้ทั้งระบบ: ค้นและทำรายการตามหน้าจอ

## เสร็จเมื่อ

- [ ] หน้าตรงกับ Canvas ที่ 1440 px · ที่ 390 px ใช้งานได้ (อ่านได้ ตารางเลื่อนแนวนอน)
- [ ] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, ไม่มีสิทธิ์ · ซ่อนปุ่มตามบทบาท
- [ ] ใช้ชิ้นส่วนมาตรฐานจาก O10 (ชิป ปุ่มสลับ แท็บ ช่องกรอก Modal Drawer Toast) · สีจาก token เท่านั้น
- [ ] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/ops-web typecheck test build` ผ่าน
- [ ] build และ deploy Docker ในเครื่องตาม CLAUDE.md แล้วตรวจ flow ที่ทำผ่าน container

## ไม่อยู่ในงานนี้

- เฟส 2–3 ตามป้ายในหน้าจอ

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
