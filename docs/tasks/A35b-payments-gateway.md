# A35b · API: ต่อ Gateway จริง (PromptPay QR + บัตร)

| | |
|---|---|
| Wave | O-1 · **รอผู้ใช้เลือก Gateway (Opn หรือ Stripe)** |
| รอ merge | A35a |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/payments/providers/**` · `apps/api/test/payments-gateway.e2e.test.ts` |
| หน้าจอ | Checkout (4b) · Billing › การ์ดช่องทาง |
| สเปก | [decisions.md](../decisions.md) › "Friday Ops: บทบาทพนักงาน" ข้อ 7 |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน · หน้าจอทั้งหมดของ Friday Ops อยู่ใน `design/canvas/ops/` (สำเนาของ [Canvas Friday Ops](https://claude.ai/artifact/Q8tsmLfQqS1aUJ2rNrkw9r) รุ่นที่ 40) · ทำเฉพาะสิ่งที่ติดป้าย **เฟส 1**

**ก่อนเริ่ม:** ผู้ใช้ต้องเลือก Gateway · คำแนะนำ: ขอใบเสนอราคา PromptPay จากทั้งสองเจ้า ใกล้กันเลือก Stripe (มีโค้ดอยู่แล้ว) · Opn ถูกกว่าชัดเจนเลือก Opn

## ทำอะไร

- `PaymentProvider` ของเจ้าที่เลือก: สร้าง PromptPay QR (ผูกยอดและใบแจ้งหนี้ · หมดอายุ 15 นาที), ตัดบัตรตามรอบ (ล้มแล้วลองใหม่วันที่ 1, 3, 5), 3-D Secure
- webhook: ตรวจลายเซ็น, กันประมวลผลซ้ำ, ปิดใบแจ้งหนี้ ต่ออายุ และออกเอกสาร · จ่ายซ้ำแล้วปิด QR เก่าและส่งเข้าคิว
- ดึงรายการย้อนหลังทุกเช้าเพื่อกระทบยอด (ใช้โครงจาก A35a)
- ตั้งค่าผ่าน environment (คีย์ทดสอบใน dev · ห้าม commit คีย์)

## เสร็จเมื่อ

- [ ] test ด้วย payload webhook ตัวอย่างของผู้ให้บริการ · ทดสอบกับ sandbox ของผู้ให้บริการในเครื่อง
- [ ] `pnpm --filter @friday/api typecheck test` ผ่าน

## ไม่อยู่ในงานนี้

- Bill Payment ผ่านธนาคาร และ Slip API (เฟส 2 · เพิ่มเมื่อมีลูกค้าองค์กรที่ต้องใช้ / สลิปเกินราว 50 ใบต่อเดือน)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
