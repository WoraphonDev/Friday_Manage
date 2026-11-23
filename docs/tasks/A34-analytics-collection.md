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

- ~~หน้าเว็บยังไม่ส่ง `attribution` ตอนสมัคร และยังไม่ส่ง `feature.used`~~ ทำแล้ว (ดูหัวข้อ "งานต่อ 23 พ.ย. 2569")
- ~~`api_calls` ใน `daily_usages` ยังเป็น 0~~ ทำแล้ว
- ~~สมัครด้วย Google / Microsoft ยังไม่เก็บที่มา~~ ทำแล้ว
- ~~ops-api เปลี่ยนแพ็กเกจเองยังไม่บันทึก `subscription_changes`~~ ทำแล้ว: Ops เปลี่ยนแพ็กเกจ (`workspaces.service.ts` · actor = staff) และลดแพ็กเกจตอนจบรอบบิล (`billing.service.ts` · actor = system) บันทึกแล้ว

### งานต่อ 23 พ.ย. 2569

- **ที่มาของผู้ใช้**
  - เว็บเขียน cookie `fm_attr` (first-party อายุ 30 วัน · `src/lib/attribution.ts` ใน layout ราก) **เฉพาะเมื่อยินยอมคุกกี้วิเคราะห์** ในแบนเนอร์ R4 ตามข้อความ "คุกกี้วิเคราะห์การใช้งานจะเปิดเมื่อคุณยินยอมเท่านั้น"
  - ก่อนยินยอม จำหน้าแรกไว้ใน sessionStorage ของแท็บนั้น (ไม่ส่งออก) จึงได้ที่มาของหน้าแรกแม้ยินยอมทีหลัง · ปฏิเสธ / ถอนความยินยอม = ลบ cookie · หน้า `/work` ไม่เก็บ
  - API อ่าน cookie เองตอนสมัคร (body `attribution` ยังส่งได้และมาก่อน) จึงครบทั้งสมัครด้วยรหัสผ่าน รับคำเชิญ และ Google / Microsoft
  - OAuth อ่าน cookie ตอน `start` (ผ่าน rewrite ของเว็บ) แล้วเก็บใน state ที่ลงลายมือชื่อ เพราะ callback มาจาก provider ซึ่งอาจอยู่คนละ host
  - cookie ผิดรูปแบบ = ไม่มีที่มา ไม่ทำให้สมัครล้ม
- **`feature.used` จากเว็บ** (`trackFeature` / `useFeatureUsed` ใน `src/lib/track.ts` · กันซ้ำในแท็บวันละครั้งต่อ Workspace ต่อฟีเจอร์ · API กันซ้ำต่อคนอีกชั้น)
  - เปิดแท็บโปรเจกต์ (`ProjectShell`): table, kanban (board), gantt, timeline, calendar, automation, report (reports) · Overview / Backlog / Files ไม่ใช่ฟีเจอร์ในรายการ
  - workload: แผง Workload ในหน้า Members และ heatmap ใน Overview
  - import: นำเข้าสำเร็จ (`ImportWizard` ทุกทาง) · saved_view: ใช้หรือบันทึกมุมมอง · due_request: ส่งคำขอเลื่อน และอนุมัติ / ปฏิเสธใน Inbox
  - git: เห็น commit / PR ที่ผูกกับงานใน Drawer · line: ผูก LINE สำเร็จหรือส่งทดสอบ
- **`api`**: API บันทึกเองเมื่อคำขอด้วย API token ผ่าน rate limit (`AuthGuard` → `AnalyticsService.apiTokenUsed` · กันซ้ำในหน่วยความจำ)
- **`api_calls`**: job 01:00 รวม `calls - rejected` จาก `api_usage_hours` (มีอยู่แล้วจาก O51 · เก็บ 90 วัน จึงรันย้อนหลังได้)
- ~~หน้าสมัคร / Login ไม่มีแบนเนอร์คุกกี้~~ แก้แล้ว 23 พ.ย. (ผู้ใช้เลือกแบบ A จาก storyboard): แบนเนอร์เดียวกับหน้าสาธารณะในหน้าสมัคร · Login · ลืมรหัสผ่าน · รับคำเชิญ (ไม่ใส่หน้า onboarding เพราะอยู่หลังล็อกอิน)
- นโยบายคุกกี้: ยังไม่เคยเผยแพร่ฉบับจริง (หน้า `/legal/cookie` แสดงโครงหัวข้อ) · โครงหัวข้อระบุคุกกี้ทุกตัวแล้ว รวม `fm_attr` · ฉบับจริงต้องให้ที่ปรึกษากฎหมายเขียนแล้วเผยแพร่จาก Ops (O14) โดยใช้รายการคุกกี้ใน `docs/spec/05-business-metrics.md` › 1.1

### ทดสอบ

- `analytics.e2e.test.ts` 11 ข้อผ่าน · API ทั้งชุด 624 ข้อผ่าน (รวม openapi) · `pnpm typecheck` ผ่าน

