# O10 · ops-web: โครงใหม่ · Shell, เข้าสู่ระบบ, ชิ้นส่วนมาตรฐาน, Modal กลาง, พนักงาน

| | |
|---|---|
| Wave | O-2 |
| รอ merge | O01 |
| Lane (แก้ได้เฉพาะ) | `apps/ops-web/app/{layout.tsx,login,enroll,(console)/layout.tsx,(console)/staff}/**` · `apps/ops-web/src/{components,i18n}/**` · `apps/ops-web/messages/th/{common,staff}.json` |
| หน้าจอ | Sidebar · Topbar · Staff · Modals-Global (G1–G12) · Modals-States (S1–S7) · Modals-Security (A1, A2, A12) |
| สเปก | [06-ops-roles](../spec/06-ops-roles.md) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน · หน้าจอทั้งหมดของ Friday Ops อยู่ใน `design/canvas/ops/` (สำเนาของ [Canvas Friday Ops](https://claude.ai/artifact/Q8tsmLfQqS1aUJ2rNrkw9r) รุ่นที่ 39) · ทำเฉพาะสิ่งที่ติดป้าย **เฟส 1**

## ทำอะไร

- **ทำก่อนงานหน้าเว็บ ops อื่น:** ชิ้นส่วนมาตรฐานตามท้ายสไตล์ของทุกหน้าใน Canvas (ชิป ปุ่มสลับ แท็บ ช่องกรอก สวิตช์ ตาราง Modal Drawer Popover Toast แถบแจ้ง) · token สีชุดเดียวกับแอปลูกค้า (เฟส 1 โหมดสว่างอย่างเดียว)
- Sidebar ตามบทบาท (ซ่อนเมนูที่ไม่มีสิทธิ์ · เมนูเฟส 2–3 แสดงป้าย "เร็ว ๆ นี้") · Topbar พร้อมค้นหา Ctrl K (G1), แจ้งเตือน (G2), เมนูบัญชี (G3)
- เข้าสู่ระบบ, ลงทะเบียน 2 กุญแจ, เซสชันหมดอายุ, ยืนยันตัวตนซ้ำ (S1–S3, G4)
- Modal กลาง: ยืนยันพร้อมเหตุผล, ย้อนกลับไม่ได้, ขออนุมัติ, คำขอที่ส่งถึงฉัน, อนุมัติตัวเอง, ส่งออก (G5–G9, G12) · สถานะหน้า (S4–S7)
- หน้าพนักงาน + Audit log: แถบเตือนผู้อนุมัติคนเดียว, หลายบทบาท, แผนก, วงเงิน, สิทธิ์ฉุกเฉิน

## เสร็จเมื่อ

- [ ] หน้าตรงกับ Canvas ที่ 1440 px · ที่ 390 px ใช้งานได้ (อ่านได้ ตารางเลื่อนแนวนอน)
- [ ] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, ไม่มีสิทธิ์ · ซ่อนปุ่มตามบทบาท
- [ ] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/ops-web typecheck test build` ผ่าน
- [ ] build และ deploy Docker ในเครื่องตาม CLAUDE.md แล้วตรวจ flow ที่ทำผ่าน container

## ไม่อยู่ในงานนี้

- หน้าเรื่องอื่น (O11–O15)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
