# O15 · ops-web: ภาพรวม และธุรกิจและกำไร

| | |
|---|---|
| Wave | O-3 |
| รอ merge | O10, O06 |
| Lane (แก้ได้เฉพาะ) | `apps/ops-web/app/(console)/{page.tsx,business}/**` · `apps/ops-web/messages/th/overview-business.json` |
| หน้าจอ | Main · Business · Modals-Money (B9, B10) |
| สเปก | 03-api › 3.12 · [06-ops-roles](../spec/06-ops-roles.md) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน · หน้าจอทั้งหมดของ Friday Ops อยู่ใน `design/canvas/ops/` (สำเนาของ [Canvas Friday Ops](https://claude.ai/artifact/Q8tsmLfQqS1aUJ2rNrkw9r) รุ่นที่ 39) · ทำเฉพาะสิ่งที่ติดป้าย **เฟส 1**

## ทำอะไร

- ภาพรวม: ตัวเลขหลักและงานที่ต้องทำวันนี้
- ธุรกิจและกำไร ครบทุกการ์ด · ตั้งค่าต้นทุนและกรอกค่าการตลาด
- กราฟทำตามหลัก dataviz: แกนเดียว ป้ายกำกับ ตาราง และ hover

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
