# T00 · ตารางที่เหลือทั้งหมด + RLS

| | |
|---|---|
| Wave | 0 · ฐานราก (เริ่มก่อน) |
| รอ merge | — เริ่มได้เลย |
| Lane (แก้ได้เฉพาะ) | `packages/db/**` |
| หน้าจอ | — |
| สเปก | 01-entities หมวด A, B, I, J, K, L, M, N · 04-permissions ข้อ 5 (แบ่งหน้าที่ RLS กับ API) · `packages/db/migrations/0001_rls.sql` (แบบอย่าง policy) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- สร้างตารางที่ยังไม่มีตาม 01-entities: A `line_binding`, `line_link_code`, `calendar_feed_token` · B `sso_connection`, `verified_domain`, `project_template` · I `git_installation`, `git_repository`, `project_repository`, `git_commit`, `pull_request`, `issue_git_link` · J `notification_delivery`, `user_notification_pref`, `user_notification_setting`, `line_oa_config`, `line_group`, `email_sender_config`, `webhook_endpoint`, `project_notification_rule`, `project_notification_setting`, `report_schedule` · K `automation_rule`, `automation_run`, `saved_view`, `saved_search`, `api_token` · L `data_subject_request`, `workspace_export` · M `plan`, `subscription`, `billing_profile`, `invoice`, `payment`, `tax_document`, `wht_certificate`, `legal_document`, `legal_acceptance` · N `staff_user`, `support_access_grant`, `support_session`, `feature_flag`, `feature_flag_override`, `announcement`
- ธรรมเนียมเดียวกับตารางเดิม: ชื่อพหูพจน์, `pk()` (UUID v7), FK แบบ `(workspace_id, id)` สำหรับตารางในโปรเจกต์ / งาน, `createdAt()` · secret (LINE channel secret, SMTP password, webhook secret, OAuth token ของ Git) เก็บเป็นข้อความที่แอปเข้ารหัสแล้ว (`*_encrypted`) และเก็บ 4 ตัวท้ายแยกไว้แสดง
- RLS ใน migration ที่เขียนเอง (แบบ 0001): ตาราง Workspace → `tenant_isolation` · ตารางในโปรเจกต์ → เพิ่ม `project_access` · ของผู้ใช้เอง (`line_binding`, `line_link_code`, `calendar_feed_token`, `user_notification_*`, `saved_search`, `legal_acceptance`) → เห็นเฉพาะแถวตัวเอง · `saved_view` → ของตัวเอง หรือที่แชร์ทั้งโปรเจกต์ · `plan`, `legal_document` → friday_app อ่านได้อย่างเดียว · หมวด N และ `support_session` → friday_app ไม่มีสิทธิ์เลย (ใช้เฉพาะแอป ops)
- index สำหรับค้นหา (P1): `pg_trgm` + GIN บน `issues.title`, `issues.description`, `comments.body`, `files.name`
- ค่าเริ่มต้นของ `plan`: Free ≤ 5 คน · Team S ≤ 10 · Team M ≤ 25 · Team L ≤ 50 · Enterprise 50+ (ราคา = null ยังไม่กำหนด) ใส่เป็น seed ใน migration
- เพิ่ม test `packages/db/test/entities.test.ts`: อ่านตารางทุกตัวใน `docs/spec/01-entities.md` แล้วตรวจว่ามีตารางในฐานข้อมูล (ชื่อพหูพจน์) และเปิด RLS ครบ

## กติกาที่ต้องตรง

- งานเดียวใน repo ที่สร้าง migration ได้ · หลัง merge แล้ว lane `packages/db/**` ปิดจนกว่าจะมีงาน DB ใหม่
- migration ต้องรันบนฐานข้อมูลที่มีข้อมูลเดิมได้ (เพิ่มอย่างเดียว ไม่แก้ / ลบคอลัมน์เดิม)
- ถ้า 01-entities ขาดรายละเอียดจนต้องตัดสินใจเอง เลือกแบบที่ง่ายและบันทึกไว้ใน "บันทึกผล"

## เสร็จเมื่อ

- [x] `pnpm db:migrate` ผ่านบนฐานข้อมูลว่างและบนฐานข้อมูลที่มีข้อมูลจาก test เดิม
- [x] `entities.test.ts` ผ่าน: ทุก entity ใน 01-entities มีตารางและเปิด RLS
- [x] test RLS ใหม่: แยก Workspace, แถวของตัวเอง, friday_app อ่านหมวด N ไม่ได้, อ่าน `plan` ได้แต่แก้ไม่ได้
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด

## ไม่อยู่ในงานนี้

- endpoint ใด ๆ (เป็นของงานใน Wave 1–2)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

- เพิ่ม schema 44 ตาราง รวมครบ 106 entity ตาม `01-entities.md` และ export ผ่าน `schema/index.ts` · ทุกตารางใหม่ใช้ UUID v7 และเปิด RLS
- Migration `0005_saas_entities`: เพิ่มตาราง, enum, constraint และ FK แบบ `(workspace_id, id)` · เพิ่ม UNIQUE บน `notifications(workspace_id, id)` ก่อน FK ของ delivery โดยไม่เปลี่ยนคอลัมน์เดิม
- Migration `0006_saas_rls`: แยก Workspace + สมาชิก active, สิทธิ์โปรเจกต์, แถวส่วนตัว และ View ส่วนตัว/แชร์ · Commit และ PR อ่านได้เมื่อ repo ผูกกับโปรเจกต์ที่เข้าถึงได้ · `plans`/`legal_documents` อ่านอย่างเดียว · หมวด N ถูก revoke ทุกสิทธิ์และมี policy ปิดไว้ · สิทธิ์ละเอียดของ Role ยังคงตรวจที่ API ตามสเปก
- Migration `0007_search_indexes`: เปิด `pg_trgm` ก่อนสร้าง GIN 4 ตัวบนชื่อ/รายละเอียดงาน, คอมเมนต์ และชื่อไฟล์ · ประกาศ index ใน Drizzle ด้วยเพื่อให้ schema กับ migration ตรงกัน
- Seed Free / Team S / M / L / Enterprise ที่ 5 / 10 / 25 / 50 / ไม่จำกัด Seat · ทุก Team ใช้ features เดียวกัน · ราคาและ storage เป็น null เพราะยังไม่กำหนด
- คำตัดสิน: รหัสผูก LINE เก็บเป็น `code_hash` และหมดอายุเริ่มต้น 10 นาที; secret และ Webhook URL เก็บ `*_encrypted` + `*Last4`; เพิ่มช่อง SMTP สำหรับ A25; `legal_documents` มี body/locale สำหรับ A30; การยอมรับกฎหมายมี Workspace เป็น null ได้ตอนสมัครก่อน Onboarding และใช้ UNIQUE NULLS NOT DISTINCT กันซ้ำ
- คำตัดสิน: Workspace มี subscription ปัจจุบันได้หนึ่งแถว; เงินเป็น bigint หน่วยสตางค์ตามตารางเดิม; automation run เก็บ issue IDs เป็น snapshot และจำกัด depth 0–3 ส่วนเครื่องยนต์ A26 ต้องใช้เพดานการ trigger ตาม task ของตน; support write session ต้องมีผู้อนุมัติคนที่สองต่างจาก staff ผู้เข้าใช้งาน
- Test ใหม่: `entities.test.ts` อ่านรายการ entity จากสเปกแล้วเทียบฐานจริง/Drizzle/RLS/FK/สิทธิ์/index; `saas-rls.test.ts` ครอบคลุมทุกตาราง tenant ใหม่, ข้อมูลส่วนตัว, shared view, สิทธิ์ระบบ, การเขียนข้าม tenant และ FK ข้าม tenant; `migrations.test.ts` สร้างฐานชั่วคราวเพื่อทดสอบติดตั้งใหม่/รันซ้ำ/อัปเกรดจาก 0004 พร้อมตรวจข้อมูลผู้ใช้, โปรเจกต์, งาน, คอมเมนต์, แจ้งเตือนเดิมไม่เปลี่ยน และลบฐานชั่วคราวหลังทดสอบ
- ตั้ง DB test ให้รันทีละไฟล์เพื่อไม่ให้ fixture ที่ใช้ฐานจริงชนกัน · `pnpm typecheck` และ `pnpm test` ผ่าน: DB 97 + API 54 = 151 ข้อ · ข้าม 2 ข้อที่ต้องใช้ไฟล์แผนจริงซึ่งไม่มีใน repo
- ไม่มี endpoint ใหม่และไม่มีคำขอนอก lane · PR ของ T01 ยังรอ merge แยกจากงานนี้ จึงยังไม่มี workflow CI บน main ในฐาน branch ของ T00
