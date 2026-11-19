# O51 · Friday Ops: Rate limit ต่อลูกค้า

| | |
|---|---|
| Wave | O-6 (เฟส 3) · ผู้ใช้อนุมัติ storyboard 20 พ.ย. 2569 |
| รอ merge | O50 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/core/plan-limits.ts` (ส่งสถิติ) · endpoint ภายในของ API · `packages/db` (ตารางสถิติ) · `apps/ops-api/src/ratelimit/**` + กฎ `api_ratelimit` ใน `abuse` · `app/(console)/ratelimit/**` · `nav.ts` · messages |
| หน้าจอ | storyboard "Ops เฟส 3" › Story 2 (ขั้น 1–2) |
| สเปก | [06-ops-roles](../spec/06-ops-roles.md) |

อ่าน [README](README.md) ก่อนเริ่ม

## ทำอะไร

- **สถิติ:** API นับคำขอ / ถูกปฏิเสธ (429) ต่อ Workspace + token + endpoint ต่อนาที แล้วเขียนเป็นชุดทุก 10 วินาที (ไม่เขียนทุกคำขอ) · เก็บรายนาที 7 วัน แล้วยุบเป็นรายชั่วโมงเก็บ 90 วัน
- **ต้องทำตอนนี้:** ลูกค้าที่ชนเพดานติดกันเกิน 15 นาที (แจ้ง Owner ของลูกค้า / ดู)
- **ตาราง:** แท็บ ชนเพดาน 24 ชม. · ใกล้เพดาน (>80%) · ปรับเฉพาะราย · ค้น Workspace / token · ตัวกรอง แพ็กเกจ · มีการปรับ · ชนกี่นาทีขึ้นไป · token
- **แผงขวา:** กราฟรายนาที 24 ชม. + เส้นเพดาน · แยกตาม token และ endpoint · ปรับเพดานชั่วคราว (เขียนลง `entitlement_overrides` key `api_rpm` เดิม มีเหตุผลและวันหมด · เกิน 3 เท่าของแพ็กเกจขออนุมัติ Owner) · ระงับ token (รายชื่อที่ถูกบล็อกของ O50 + revoke) · แจ้ง Owner
- เปิดกฎ `api_ratelimit` ของ O50 (ชนเพดานเกิน 15 นาทีติดกัน +30)
- หลายเครื่อง: ยังนับในหน่วยความจำของ API ตัวเดียว · ย้ายไป Valkey ใน I01

## เสร็จเมื่อ

- [ ] หน้าตรงกับ storyboard ที่ 1440 px · ใช้งานได้ที่ 390 px
- [ ] e2e ของ API ที่แก้ + component test ของหน้า
- [ ] `pnpm typecheck` และ test ของแพ็กเกจที่แก้ผ่าน
- [ ] deploy Docker ในเครื่องตาม CLAUDE.md และตรวจผ่าน :4000 / :3000

## บันทึกผล

