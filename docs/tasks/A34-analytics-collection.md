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

- ที่มาของลูกค้า: รับ UTM / referrer ตอนสมัครแล้วเขียน `signup_attributions` · คัดลอกเป็น `workspace_acquisitions` ตอนสร้าง Workspace
- `POST w/events` รับ `feature.used` และ `limit.hit` เป็นชุด (สูงสุด 50) · ตรวจชื่อจากรายการที่อนุญาต · props ห้ามมีเนื้อหาลูกค้า · ล้มแล้วทิ้ง ไม่ทำให้คำขอของลูกค้าช้า
- ผู้ฟัง `EventBus` เขียน `subscription_changes` ทุกครั้งที่ MRR เปลี่ยน และ `cancellation_responses` จากแบบสอบถามตอนยกเลิก
- job 01:00 สรุป `daily_usages` (ใช้ `SYSTEM_DB` พร้อมเหตุผลในคอมเมนต์)
- ลบบัญชีแล้วลบ / ทำให้ระบุตัวไม่ได้ตาม 05 › 3

## เสร็จเมื่อ

- [x] test ครอบคลุมทุกข้อ · `pnpm --filter @friday/api typecheck test` ผ่าน
- [x] ไม่มี SDK วิเคราะห์ของบุคคลที่สาม

## ไม่อยู่ในงานนี้

- หน้าจอและตัวเลข (O06)

## บันทึกผล

### สิ่งที่เพิ่ม

- module `analytics` (Global) + `AnalyticsService`
- `POST w/{ws}/events` (202): `feature.used` (14 ฟีเจอร์ · นับครั้งแรกของวันต่อคนต่อฟีเจอร์), `limit.hit`, `upgrade.prompt_shown / clicked`, `onboarding.step_done`, `checkout.started / method_selected` · props เป็น strict object ทุกชนิด จึงใส่เนื้อหาของลูกค้าไม่ได้ · บันทึกไม่สำเร็จตอบ `{ accepted: 0 }` ไม่ล้ม
- `POST w/{ws}/cancellation-feedback` (Owner) → `cancellation_responses`
- `POST auth/signup` รับ `attribution` (utm_*, referrer, landingPath, firstSeenAt) → `signup_attributions` · เก็บแค่ host ของ referrer และตัด query ของ path
- สร้าง Workspace → `workspace_acquisitions` คัดลอกจากผู้สร้าง · **ผู้สร้างเคยเป็นสมาชิก (ไม่ใช่ Owner) ของ Workspace อื่น = `invited_user`** พร้อม `referring_workspace_id` (ไม่ต้องแก้ขั้นตอนรับคำเชิญ)
- `subscription_changes`: ชำระเงินสำเร็จ (`payments.service.settle`) บันทึก new / upgrade / downgrade / cycle_change / reactivate ตาม `classifyChange` · MRR = subtotal (รายปีหาร 12) · ยกเลิกแพ็กเกจที่จ่ายเงินบันทึก `cancel` MRR 0 ณ สิ้นรอบ (ยกเลิกช่วงทดลองไม่บันทึก)
- งาน `analytics.daily_usage` ทุกวัน 01:00 → `daily_usages` ของเมื่อวาน (LINE, อีเมล, Webhook ที่ส่งสำเร็จ · พื้นที่ไฟล์ · Automation · ผู้ใช้ที่ active) · รันซ้ำได้
- PDPA: `anonymizeIfOrphan` เรียก `forgetUser` → ลบ `signup_attributions` และตั้ง `user_id` เป็น null ใน `product_events` / `cancellation_responses`

### คำขอนอก lane (ทำแล้วในงานนี้)

- `app.module.ts` ลงทะเบียน `AnalyticsModule` (module ใหม่ ไม่มีที่ว่างรอไว้)
- `auth/auth.controller.ts` (SignupBody + บันทึกที่มา), `workspaces/workspaces.controller.ts`, `payments/payments.service.ts`, `payments/invoices.service.ts`, `privacy/data-requests.service.ts` เรียก `AnalyticsService` บรรทัดเดียวในแต่ละจุด
- `apps/api/openapi.json` สร้างใหม่

### ยังไม่ได้ทำ

- หน้าเว็บยังไม่ส่ง `attribution` ตอนสมัคร และยังไม่ส่ง `feature.used` (งานเว็บ · บันทึกไว้ให้ W01 / W22 / งานหน้าเว็บที่เกี่ยวข้อง)
- `api_calls` ใน `daily_usages` ยังเป็น 0 จนกว่าจะเก็บ log ของ API token
- สมัครด้วย Google / Microsoft ยังไม่เก็บที่มา (ขั้นตอน redirect ไม่มีที่ส่งข้อมูล) · Workspace ของผู้ใช้เหล่านี้ยังได้ `workspace_acquisitions` (via = signup หรือ invited_user)
- ops-api เปลี่ยนแพ็กเกจเองยังไม่บันทึก `subscription_changes` (เพิ่มใน O02)

### ทดสอบ

- `analytics.e2e.test.ts` 11 ข้อผ่าน · API ทั้งชุด 624 ข้อผ่าน (รวม openapi) · `pnpm typecheck` ผ่าน

