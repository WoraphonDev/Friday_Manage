# A42 · API: มีอะไรใหม่ และแบบสำรวจ NPS ในแอปลูกค้า

| | |
|---|---|
| Wave | O-4 · อนุมัติหน้าจอแล้ว 12 พ.ย. 2569 |
| รอ merge | O32 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/changelog/**` (module ใหม่ · รวม NPS) · `apps/api/test/changelog.e2e.test.ts` |
| หน้าจอ | `design/proposals/phase3/01-changelog-nps.html` › U1 แผงมีอะไรใหม่ · U2 Spotlight · U3 แบบสำรวจ NPS |
| สเปก | [05-business-metrics](../spec/05-business-metrics.md) |

อ่าน [README](README.md) ก่อนเริ่ม · หน้าจอใน `design/proposals/phase3` ผู้ใช้อนุมัติแล้ว (12 พ.ย. 2569) ยึดตามไฟล์นั้น

## ทำอะไร

- `GET me/whats-new?workspace` · รายการที่เผยแพร่ 90 วัน กรองตามแพ็กเกจ / Feature flag ของ Workspace / บทบาท · `unseen` สำหรับจุดบนแถบบน · ไม่ส่งให้ Guest และ Workspace ที่ถูกระงับ
- `POST me/whats-new:seen` (บันทึกเวลาเปิดแผง + เพิ่มยอดเห็น) · `POST me/whats-new/{id}:click` · `GET me/spotlight` (คืนได้ไม่เกิน 1 รายการที่ยังไม่เห็น) · `POST me/spotlight/{id}:dismiss`
- `GET me/nps-prompt?workspace` ตัดสินว่าจะถามไหมตาม `nps_settings` (บทบาท, ใช้งานครบ N วัน, ถามซ้ำทุก N วัน, สุ่ม %, ไม่ถามเมื่อทดลองใช้ < 14 วัน / มี Ticket เปิดหรือปิดใน 7 วัน / เห็น Spotlight วันนี้) · `POST me/nps` (score, comment, topics) · `POST me/nps:dismiss`
- คำตอบ NPS เขียนผ่าน `TenantDb.run` · ไม่ส่งเนื้อหาไป `product_events`
- **ไม่ทำ** แบบสอบถามตอนยกเลิก (มีแล้วใน W22 / `cancellation-feedback`)

## เสร็จเมื่อ

- [x] e2e test ด้วยข้อมูลสมมติ: กรองกลุ่มผู้เห็น · flag · Guest · เกณฑ์ถาม NPS ทุกข้อ · ปิดโดยไม่ตอบ · Spotlight ทีละรายการ
- [x] `pnpm typecheck` / `pnpm --filter @friday/api test` ผ่าน
- [x] build และ deploy Docker API (`compose.api.yml`) ด้วยฐานข้อมูลเดิม แล้วเรียก endpoint จริงผ่าน :3001

## ยังต้องตัดสินใจ

**ผู้ใช้ตัดสินแล้ว (12 พ.ย. 2569): ใช้ตามคำแนะนำทุกข้อ** · ข้อความ "แนะนำ" ด้านล่างคือคำตัดสิน

- **ถาม NPS ใคร** · **แนะนำ:** Owner และ Admin เท่านั้นในรอบแรก (คนตัดสินใจต่ออายุ · รบกวนน้อย) แล้วค่อยเปิดให้สมาชิกถ้าคำตอบน้อย
- **ใช้คะแนน NPS ในคะแนนสุขภาพลูกค้า** · **แนะนำ:** ใช่ แต่ให้น้ำหนักหลังมีข้อมูลจริง 3 เดือน (ตามลำดับใน 05 ข้อ 4)

## บันทึกผล

**12 พ.ย. 2569 · branch `task/changelog-nps-A42-O33-W24`** · ไม่มี migration ใหม่ (ใช้ตารางของ O32 / 0033)

**Endpoint** (`apps/api/src/changelog/` · ลงทะเบียน `ChangelogModule` ใน `app.module.ts` · `openapi.json` สร้างใหม่ · เพิ่มแถวใน `03-api.md`)
- `GET me/whats-new?workspace=` → `{ items, unseen, seenAt, hidden }` · 90 วัน ใหม่ไปเก่า (สูงสุด 50) · item มีฉบับไทย + `titleEn / summaryEn / bodyEn` (ว่าง = เว็บแสดงไทย) · `media`, `cta { label, labelEn, path }`, `date` (display_date หรือวันเผยแพร่ตามเวลาไทย), `unseen` · ไม่ส่ง audience / ข้อมูลภายใน
- `POST me/whats-new/seen { workspace }` บันทึก `whats_new_seen_at` และนับยอดเห็นเฉพาะรายการที่ใหม่กว่าครั้งก่อนที่เปิด (≈ 1 ครั้งต่อคนต่อรายการ ไม่เก็บว่าใครอ่าน) · `POST me/whats-new/{id}/click`
- `GET me/spotlight?workspace=` → `{ item }` ≤ 1 รายการที่ยังไม่เห็น · `POST me/spotlight/{id}/dismiss` (นับเป็นเห็น 1 ครั้ง · บันทึก `spotlight_seen_at`)
- `GET me/nps-prompt?workspace=&mobile=&sessionSeconds=` → `{ ask: true, question, questionEn, followUps, followUpsEn, topics, excludeShortMobile }` หรือ `{ ask: false, reason }` · `POST me/nps { workspace, score, comment?, topics? }` → `{ id, score, group }` · `POST me/nps/dismiss { workspace }`
- รูปแบบ path ใช้ `/seen`, `/{id}/click`, `/dismiss` แบบเดียวกับ `me/notifications/read-all` ของโค้ดเดิม (สเปกเขียน `:seen`)

**กติกาที่ทำ**
- Guest และ Workspace ที่ถูกระงับ (ทั้ง read_only / full) ได้รายการว่าง + `hidden: true` / `{ item: null }` / `{ ask: false }` แทน error ให้เว็บซ่อนปุ่มเงียบ ๆ · ไม่ใช่สมาชิก = 404
- กลุ่มผู้เห็น: `plans` ตามแพ็กเกจที่ใช้สิทธิ์จริง (`effectivePlan` · ทดลองหมด = free) · `flag` ตาม override ของ Workspace ก่อน แล้วค่าตั้งต้นของ flag (flag ที่ลบแล้ว = ไม่มีใครเห็น) · `admins` = Owner / Admin
- `feature_flags`, `support_tickets` เป็นตาราง ops_only จึงอ่านด้วย `SYSTEM_DB` (มีคอมเมนต์) · ที่เหลือผ่าน `TenantDb.run`
- NPS ถามเมื่อผ่านทุกข้อตามลำดับ: เปิดใช้ · บทบาท (`admins` = Owner / Admin · `members` = ยกเว้น Guest) · มือถือที่ใช้งานไม่ถึง 120 วินาทีเมื่อเปิด `exclude_short_mobile` (เว็บส่ง `mobile` / `sessionSeconds` · ตอบ `short_mobile` โดยยังไม่บันทึกว่าถาม) · ยังไม่ถูกถามวันนี้ (เวลาไทย) · ตอบ / ปิดครั้งล่าสุดเกิน `repeat_days` · บัญชีอายุครบ `first_after_days` (เฉพาะครั้งแรก) · ไม่ใช่วันที่เห็น Spotlight · Workspace ทดลองใช้ที่อายุยังไม่ถึง `exclude_trial_days` · ไม่มี Ticket ของตัวเองหรือของ Workspace ที่เปิดอยู่ / ปิดภายใน `exclude_ticket_days` · สุ่มตาม `sample_pct`
- สุ่มแบบคงที่ต่อคนต่อรอบ (hash ของ user + รอบ `repeat_days`) เพื่อไม่ให้รีเฟรชจนโดนถาม · ถาม = บันทึก `nps_prompted_at` (≤ 1 ครั้งต่อวัน) · ตอบ / ปิดได้เฉพาะเมื่อถูกถามแล้วยังไม่ตอบ (409 `nps_not_prompted`)
- คำตอบเขียนด้วย SQL ระบุคอลัมน์ (grant รายคอลัมน์ของ O32) · เก็บ role และแพ็กเกจตอนตอบ · ปิดโดยไม่ตอบ = แถว score ว่าง · ไม่ส่งอะไรเข้า `product_events`
- ไม่มีแถว `nps_settings` (ฐานทดสอบที่ล้างตาราง) ใช้ค่าเริ่มต้นเดียวกับ migration
- Spotlight ไม่แสดงในวันแรกที่สมัคร (ให้ Onboarding V1 ก่อน) · เงื่อนไข 3 วินาที / กำลังพิมพ์ / เปิด Drawer ตัดสินที่เว็บ (W24)
- คำตัดสิน: ถาม NPS เฉพาะ Owner / Admin (ค่าเริ่มต้นของ `nps_settings`) · ยังไม่นำคะแนนเข้าคะแนนสุขภาพ (รอข้อมูลจริง 3 เดือน)
- ไม่ทำแบบสอบถามตอนยกเลิก (มีใน W22 / `cancellation-feedback`)

**ตรวจแล้ว:** `apps/api/test/changelog.e2e.test.ts` 16 ข้อ (กรองกลุ่มผู้เห็น · flag / override · Guest / ระงับ · ยอดเห็น / คลิก · Spotlight ทีละรายการ / วันแรก · เกณฑ์ NPS ทุกข้อรวมมือถือใช้งานสั้น · ตอบ / ปิด / ตอบซ้ำ · RLS) · `@friday/api` 700 ผ่าน (7 ข้าม) บนฐาน `friday_s_changelog` · typecheck / build ผ่าน · ยังไม่ได้ build / deploy Docker (ผู้ประสานงานทำต่อ)

**ตรวจบน Docker ในเครื่อง (13 พ.ย. 2569)** · web :3000 · API :3001 · ops :4000/:4001 build จาก main `b2d1059` + งานแก้ใน PR นี้ · ฐานข้อมูล `friday_canvas_qa` เดิม (ไม่ล้าง)
- เผยแพร่รายการจาก :4000 (Spotlight) → `me/whats-new` `unseen: 1` และ `me/spotlight` คืนรายการ · ปิด Spotlight แล้วไม่แสดงซ้ำ
- NPS: `me/nps-prompt` ตอบ `too_new` / `asked_today` / `short_mobile` ตามเกณฑ์ · เปิดเกณฑ์ชั่วคราวใน U5 แล้วตอบ 8 คะแนน + หัวข้อ + ความเห็นจากหน้าเว็บ → เห็นใน `ops/nps/responses` (คืนค่าตั้ง NPS เดิมแล้ว)
