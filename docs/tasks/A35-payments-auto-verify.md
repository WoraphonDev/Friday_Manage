# A35 · API: ยืนยันการชำระเงินอัตโนมัติ

| | |
|---|---|
| Wave | O-1 · **รอผู้ใช้เลือกผู้ให้บริการ** |
| รอ merge | O00 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/payments/**` · `apps/api/test/payments-auto.e2e.test.ts` |
| หน้าจอ | Checkout (หน้าชำระเงินฝั่งลูกค้า) · Billing › กรณีผิดปกติ |
| สเปก | decisions › SaaS · บันทึกการเปรียบเทียบผู้ให้บริการในแชต 9 พ.ย. 2569 |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน · หน้าจอทั้งหมดของ Friday Ops อยู่ใน `design/canvas/ops/` (สำเนาของ [Canvas Friday Ops](https://claude.ai/artifact/Q8tsmLfQqS1aUJ2rNrkw9r) รุ่นที่ 39) · ทำเฉพาะสิ่งที่ติดป้าย **เฟส 1**

**ก่อนเริ่ม:** ผู้ใช้ต้องเลือก Gateway (Opn หรือ Stripe), ธนาคารสำหรับ Bill Payment และ Slip API · และยืนยันสถานะจด VAT

## ทำอะไร

- PromptPay QR และบัตรผ่าน Gateway: webhook แล้วปิดใบแจ้งหนี้ ต่ออายุ และออก e-Tax · กันจ่ายซ้ำ (ปิด QR เก่า)
- Bill Payment (Ref.1 = รหัสลูกค้า, Ref.2 = ใบแจ้งหนี้) จากธนาคาร
- สลิปโอนเป็นทางสำรอง: ตรวจผ่าน Slip API · ไม่ตรงแล้วตั้ง `exception_reason` ให้เข้าคิว
- หัก ณ ที่จ่าย: ยอดลด 3% เมื่อลูกค้าเปิดตัวเลือก · ใช้ได้กับ QR และ Bill Payment
- กระทบยอดกับ statement ทุกเช้า จับ webhook ที่หลุด
- ใช้ provider interface ที่มีอยู่ (`providers.ts`) · มีตัวจำลองสำหรับ test

## เสร็จเมื่อ

- [ ] test ครอบคลุมทุกช่องทางและกรณีผิดปกติ 7 แบบในคิว · `pnpm --filter @friday/api typecheck test` ผ่าน

## ไม่อยู่ในงานนี้

- คิวใน Friday Ops (O03) · หน้าชำระเงิน (W22)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
