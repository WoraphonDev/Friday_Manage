# A42 · API: มีอะไรใหม่ และแบบสำรวจ NPS ในแอปลูกค้า

| | |
|---|---|
| Wave | O-4 · **รอผู้ใช้อนุมัติหน้าจอใน `design/proposals/phase3`** |
| รอ merge | O32 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/changelog/**` (module ใหม่ · รวม NPS) · `apps/api/test/changelog.e2e.test.ts` |
| หน้าจอ | `design/proposals/phase3/01-changelog-nps.html` › U1 แผงมีอะไรใหม่ · U2 Spotlight · U3 แบบสำรวจ NPS |
| สเปก | [05-business-metrics](../spec/05-business-metrics.md) |

อ่าน [README](README.md) ก่อนเริ่ม · หน้าจอเป็น**ข้อเสนอ** เริ่มได้เมื่อผู้ใช้อนุมัติไฟล์ 01 แล้ว

## ทำอะไร

- `GET me/whats-new?workspace` · รายการที่เผยแพร่ 90 วัน กรองตามแพ็กเกจ / Feature flag ของ Workspace / บทบาท · `unseen` สำหรับจุดบนแถบบน · ไม่ส่งให้ Guest และ Workspace ที่ถูกระงับ
- `POST me/whats-new:seen` (บันทึกเวลาเปิดแผง + เพิ่มยอดเห็น) · `POST me/whats-new/{id}:click` · `GET me/spotlight` (คืนได้ไม่เกิน 1 รายการที่ยังไม่เห็น) · `POST me/spotlight/{id}:dismiss`
- `GET me/nps-prompt?workspace` ตัดสินว่าจะถามไหมตาม `nps_settings` (บทบาท, ใช้งานครบ N วัน, ถามซ้ำทุก N วัน, สุ่ม %, ไม่ถามเมื่อทดลองใช้ < 14 วัน / มี Ticket เปิดหรือปิดใน 7 วัน / เห็น Spotlight วันนี้) · `POST me/nps` (score, comment, topics) · `POST me/nps:dismiss`
- คำตอบ NPS เขียนผ่าน `TenantDb.run` · ไม่ส่งเนื้อหาไป `product_events`
- **ไม่ทำ** แบบสอบถามตอนยกเลิก (มีแล้วใน W22 / `cancellation-feedback`)

## เสร็จเมื่อ

- [ ] e2e test ด้วยข้อมูลสมมติ: กรองกลุ่มผู้เห็น · flag · Guest · เกณฑ์ถาม NPS ทุกข้อ · ปิดโดยไม่ตอบ · Spotlight ทีละรายการ
- [ ] `pnpm typecheck` / `pnpm --filter @friday/api test` ผ่าน
- [ ] build และ deploy Docker API (`compose.api.yml`) ด้วยฐานข้อมูลเดิม แล้วเรียก endpoint จริงผ่าน :3001

## ยังต้องตัดสินใจ

- **ถาม NPS ใคร** · **แนะนำ:** Owner และ Admin เท่านั้นในรอบแรก (คนตัดสินใจต่ออายุ · รบกวนน้อย) แล้วค่อยเปิดให้สมาชิกถ้าคำตอบน้อย
- **ใช้คะแนน NPS ในคะแนนสุขภาพลูกค้า** · **แนะนำ:** ใช่ แต่ให้น้ำหนักหลังมีข้อมูลจริง 3 เดือน (ตามลำดับใน 05 ข้อ 4)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน -->
