# A34 · API: เก็บข้อมูลธุรกิจตั้งแต่วันแรก

| | |
|---|---|
| Wave | O-1 |
| รอ merge | O00 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/analytics/**` · `apps/api/test/analytics.e2e.test.ts` |
| หน้าจอ | — (ไม่มีหน้าจอ) |
| สเปก | [05-business-metrics](../spec/05-business-metrics.md) › 1 |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน · หน้าจอทั้งหมดของ Friday Ops อยู่ใน `design/canvas/ops/` (สำเนาของ [Canvas Friday Ops](https://claude.ai/artifact/Q8tsmLfQqS1aUJ2rNrkw9r) รุ่นที่ 40) · ทำเฉพาะสิ่งที่ติดป้าย **เฟส 1**

**คำขอนอก lane ที่คาดไว้:** W01 ส่ง UTM ตอนสมัคร · W19 / W22 แสดงแบบสอบถามตอนยกเลิก

## ทำอะไร

- ที่มาของลูกค้า: รับ UTM / referrer ตอนสมัครแล้วเขียน `signup_attribution` · คัดลอกเป็น `workspace_acquisition` ตอนสร้าง Workspace
- `POST w/events` รับ `feature.used` และ `limit.hit` เป็นชุด (สูงสุด 50) · ตรวจชื่อจากรายการที่อนุญาต · props ห้ามมีเนื้อหาลูกค้า · ล้มแล้วทิ้ง ไม่ทำให้คำขอของลูกค้าช้า
- ผู้ฟัง `EventBus` เขียน `subscription_changes` ทุกครั้งที่ MRR เปลี่ยน และ `cancellation_feedback` จากแบบสอบถามตอนยกเลิก
- job 01:00 สรุป `usage_daily` (ใช้ `SYSTEM_DB` พร้อมเหตุผลในคอมเมนต์)
- ลบบัญชีแล้วลบ / ทำให้ระบุตัวไม่ได้ตาม 05 › 3

## เสร็จเมื่อ

- [ ] test ครอบคลุมทุกข้อ · `pnpm --filter @friday/api typecheck test` ผ่าน
- [ ] ไม่มี SDK วิเคราะห์ของบุคคลที่สาม

## ไม่อยู่ในงานนี้

- หน้าจอและตัวเลข (O06)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
