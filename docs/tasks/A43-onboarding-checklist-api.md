# A43 · API: Onboarding checklist ของลูกค้า

| | |
|---|---|
| Wave | O-4 · อนุมัติหน้าจอแล้ว 12 พ.ย. 2569 |
| รอ merge | O32 · A34 (ใช้ `onboarding.step_done`) |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/onboarding/**` (module ใหม่) · `apps/api/test/onboarding.e2e.test.ts` |
| หน้าจอ | `design/proposals/phase3/02-onboarding-checklist.html` › V1–V4 |
| สเปก | [05-business-metrics](../spec/05-business-metrics.md) › 1.2 (`onboarding.step_done`) · 2 (นิยาม "เริ่มใช้จริง") |

อ่าน [README](README.md) ก่อนเริ่ม · หน้าจอใน `design/proposals/phase3` ผู้ใช้อนุมัติแล้ว (12 พ.ย. 2569) ยึดตามไฟล์นั้น

## ทำอะไร

- ขั้นของ Workspace (Owner / Admin เห็น) ตรวจจากข้อมูลจริง ไม่ใช่การกดติ๊ก:
  1. โปรเจกต์ที่ไม่ใช่ตัวอย่าง ≥ 1 · 2. งาน (ไม่นับที่ลบ) ≥ 10 · 3. สมาชิกที่ตอบรับ ≥ 3 รวมเจ้าของ ไม่นับ Guest · 4. งานที่มีผู้รับผิดชอบและ Due ≥ 5 · 5. เปลี่ยนสถานะงาน ≥ 1 · 6. มีสมาชิกผูก LINE หรือเปิดอีเมลแจ้งเตือน ≥ 1
- ขั้นส่วนตัวของสมาชิก (V3): ตั้งรูปและเวลาทำงาน · เปิดงานแรกที่ได้รับมอบหมาย · เลือกช่องทางแจ้งเตือน
- `GET w/onboarding` คืนขั้น สถานะ ตัวเลขประกอบ (เช่น 1 / 2 คน) ขั้นถัดไป และลิงก์ปุ่ม · `POST w/onboarding:hide` / `:show` / `:never` ต่อคน
- ฟัง `issue.created`, `member.joined` ฯลฯ ผ่าน `EventBus.on` ใน `onModuleInit` · เมื่อขั้นเสร็จครั้งแรกบันทึก `onboarding_progress` แล้ว `EventBus.publish('onboarding.step_done')` (ให้ A34 เขียน `product_events`)
- Workspace ที่สร้างก่อนเปิดฟีเจอร์และ "เริ่มใช้จริง" แล้วไม่แสดงการ์ด
- เหตุการณ์ต่อท้าย `EventType`: `onboarding.step_done` (ถ้ายังไม่มี) · `onboarding.completed`

## เสร็จเมื่อ

- [x] e2e test ด้วยข้อมูลสมมติครอบคลุมทุกขั้น · ซ่อน / แสดง · สมาชิก vs Owner / Admin · Guest ไม่เห็น · Workspace เก่าไม่เห็น
- [x] ทุก query ผ่าน `TenantDb.run` · `pnpm typecheck` / `pnpm --filter @friday/api test` ผ่าน
- [ ] build และ deploy Docker API (`compose.api.yml`) ด้วยฐานข้อมูลเดิม แล้วเรียก endpoint จริงผ่าน :3001

## ยังต้องตัดสินใจ

**ผู้ใช้ตัดสินแล้ว (12 พ.ย. 2569): ใช้ตามคำแนะนำทุกข้อ** · ข้อความ "แนะนำ" ด้านล่างคือคำตัดสิน

- **6 ขั้นที่เสนอ** (ขั้น 2–3 ตามนิยาม "เริ่มใช้จริง" และขั้น 6 เพราะลูกค้าที่ผูก LINE ยกเลิกน้อยกว่า 2.4 เท่าในหน้า "ธุรกิจและกำไร") · **แนะนำ:** ใช้ 6 ขั้นนี้ แล้วทบทวนเมื่อมีข้อมูล 3 เดือน
- **รายการส่วนตัวของสมาชิก (V3)** · **แนะนำ:** ทำพร้อมกัน เพราะใช้กลไกเดียวกันและช่วยให้สมาชิกใหม่ตั้งเวลาทำงาน (Workload ถูกต้อง) · ตัดออกได้ถ้าต้องการลดงาน

## บันทึกผล

ส่งงาน 12 พ.ย. 2569 · module `apps/api/src/onboarding` · ไม่มี migration (ใช้ตารางของ O32 · 0033)

**Endpoint** (`w/{ws}` · สมาชิกที่ไม่ใช่ Guest · Guest ได้ 403)
- `GET w/onboarding` → `{ scope: workspace | member, version, eligible, steps[{ key, title, done, doneAt, current, target, action{kind, path}, detail }], doneCount, total, next, completed, hidden, never, completionSeen, invitedBy? }` · `path` ต่อจาก `/work/{ws}/` · `eligible: false` = Workspace เก่าที่ใช้จริงแล้ว หรือสมาชิกที่เข้าร่วมก่อนเปิดฟีเจอร์
- `POST w/onboarding:hide` · `:show` (ล้างทั้งซ่อนและไม่ต้องแสดงอีก) · `:never` · `:complete-seen` (V4 แสดงครั้งเดียว) · `:task-opened { issueKey }` (ปุ่ม "เปิดงาน" ของ V3 · ต้องเป็นงานที่ได้รับมอบหมาย ไม่งั้น 404)

**ขั้น** (แก้ใน `src/onboarding/steps.ts` · `ONBOARDING_VERSION = 1` · เปิดฟีเจอร์ 12 พ.ย. 2569)
- Workspace: `first_project` · `issues` (≥ 10) · `team` (สมาชิก active ไม่ใช่ Guest ≥ 3 · แสดงเป็นเพื่อนร่วมทีม n / 2 พร้อมคำเชิญค้าง) · `assign_due` (มีผู้รับผิดชอบและ Plan End ≥ 5) · `status_update` (activity field statusId โดยผู้ใช้ ≥ 1) · `notifications` (สมาชิกผูก LINE หรือบันทึกการตั้งค่าแจ้งเตือน / เปิดอีเมลเอง ≥ 1 คน · อีเมลเปิดเป็นค่าเริ่มต้นอยู่แล้วจึงนับเฉพาะที่ตั้งเอง)
- ไม่นับโปรเจกต์ตัวอย่าง (`SAMPLE_PROJECT_NAME` ที่ export เพิ่มใน `projects/sample-project.service.ts`) และงานในนั้น เพราะโปรเจกต์ตัวอย่างมีงานมอบหมายพร้อม Due 9 งานจะทำให้ขั้นผ่านเอง
- สมาชิก (V3 · บทบาท Member): `profile` (มีรูป + ตั้งเวลาทำงานเอง) · `open_assigned` (กดปุ่มเปิดงาน หรือเคยแก้ / คอมเมนต์งานที่ได้รับมอบหมาย · ไม่มีการเก็บว่าเปิดงานไหน) · `notify_channel` (ผูก LINE หรือบันทึกการตั้งค่าแจ้งเตือนของ Workspace นี้)

**การบันทึกและเหตุการณ์**
- บันทึกครั้งแรกที่เสร็จใน `onboarding_progress` ในนามผู้ที่ทำขั้น (TenantDb + RLS) แล้วไม่ย้อนกลับ · `done_at` ใช้เวลาที่เงื่อนไขเป็นจริงเมื่อหาได้ (โปรเจกต์แรก, งานที่ 10, สมาชิกคนที่ 3, เปลี่ยนสถานะครั้งแรก, ผูก LINE) ให้เวลาเฉลี่ยใน Ops ถูกต้อง · meta เป็นตัวเลขเท่านั้น (`count`, `imported`)
- ผู้ฟัง (`EventBus.on` ใน `onModuleInit`) ตรวจเฉพาะขั้นที่เกี่ยวกับเหตุการณ์: `issue.created` / `import.completed` → งาน + มอบหมาย · `issue.assigned` / `issue.updated` → มอบหมาย · `issue.status_changed` → สถานะ · `member.joined` ที่มี `via` (เข้าร่วม Workspace) → ทีม · โปรเจกต์แรกและแจ้งเตือนไม่มีเหตุการณ์ จึงตรวจตอนเรียก GET (ทั้ง Owner และสมาชิกช่วยบันทึก) และงานทุกคืน
- งานทุกคืน `onboarding.reconcile` 01:30 ตรวจ Workspace อายุ ≤ 120 วันที่ยังไม่ครบ (ลูกค้าที่ไม่กลับมาเปิด Home ก็ยังมีข้อมูลให้ Friday Ops)
- `onboarding.step_done` เขียน `product_events` (props `{ step, version }` · ขั้นส่วนตัวขึ้นต้น `member.`) ในธุรกรรมเดียวกับ `onboarding_progress` จึงนับครั้งเดียวแน่นอน แล้ว `EventBus.publish('onboarding.step_done')` และ `onboarding.completed` (data.scope) หลัง commit · เพิ่มทั้งสองใน `EventType` และ 03-api

**ต่างจากข้อความงาน**
- ตัวเลขของขั้น Workspace นับผ่าน `SYSTEM_DB` จำกัดที่ Workspace ปัจจุบันและคืนเป็นตัวเลขเท่านั้น (เขียนเหตุผลในคอมเมนต์) เพราะ RLS ซ่อนงานในโปรเจกต์ private ที่ผู้ดูไม่ได้เป็นสมาชิก และการผูก LINE / ตั้งค่าแจ้งเตือนของคนอื่น (แบบเดียวกับ `mfaStats` ของ Admin) · การอ่าน / เขียนอื่นทั้งหมดผ่าน `TenantDb.run` · งานทุกคืนใช้ SYSTEM_DB เพราะเป็นงานระบบข้ามทุก Workspace
- `product_events` เขียนใน module นี้เอง (ไม่ผ่าน AnalyticsService) เพื่อให้อยู่ในธุรกรรมเดียวกับการบันทึกขั้น
- Workspace เก่าที่ "เริ่มใช้จริง" ใช้เงื่อนไขปัจจุบัน (สมาชิก ≥ 3 และงาน ≥ 10) ไม่จำกัด 7 วันแรก เพราะเป็นการตัดสินว่าทีมใช้เป็นแล้วหรือยัง · สมาชิกที่เข้าร่วมก่อนเปิดฟีเจอร์ไม่เห็นรายการส่วนตัว

**ตรวจแล้ว:** `test/onboarding.e2e.test.ts` 13 ข้อ (ทุกขั้นของ Workspace · ขั้นเสร็จจากเหตุการณ์ · ไม่ย้อนกลับ · โปรเจกต์ตัวอย่างไม่นับ · Guest ไม่นับ / ไม่เห็น · ซ่อน / แสดง / ไม่ต้องแสดงอีก / เห็นการ์ดครบ · รายการสมาชิก + ผู้ชวน + task-opened · Workspace / สมาชิกเก่า · งานทุกคืน) · `pnpm --filter @friday/api test` 698 ผ่าน · typecheck ผ่าน · openapi.json สร้างใหม่ · ยังไม่ได้ build / deploy Docker (ผู้ประสานงานทำต่อ)
