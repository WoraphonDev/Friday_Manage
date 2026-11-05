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

- [ ] `pnpm db:migrate` ผ่านบนฐานข้อมูลว่างและบนฐานข้อมูลที่มีข้อมูลจาก test เดิม
- [ ] `entities.test.ts` ผ่าน: ทุก entity ใน 01-entities มีตารางและเปิด RLS
- [ ] test RLS ใหม่: แยก Workspace, แถวของตัวเอง, friday_app อ่านหมวด N ไม่ได้, อ่าน `plan` ได้แต่แก้ไม่ได้
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด

## ไม่อยู่ในงานนี้

- endpoint ใด ๆ (เป็นของงานใน Wave 1–2)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
