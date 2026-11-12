# O32 · ตารางของ Changelog, NPS, Onboarding checklist, ศูนย์ช่วยเหลือ และการผูก Ticket กับงาน

| | |
|---|---|
| Wave | O-4 · อนุมัติหน้าจอแล้ว 12 พ.ย. 2569 |
| รอ merge | O30 (lane เดียวกัน) |
| Lane (แก้ได้เฉพาะ) | `packages/db/**` |
| หน้าจอ | `design/proposals/phase3/` › 01 · 02 · 03 · 04 |
| สเปก | [05-business-metrics](../spec/05-business-metrics.md) · [06-ops-roles](../spec/06-ops-roles.md) · [01-entities](../spec/01-entities.md) |

อ่าน [README](README.md) ก่อนเริ่ม · หน้าจอใน `design/proposals/phase3` ผู้ใช้อนุมัติแล้ว (12 พ.ย. 2569) ยึดตามไฟล์นั้น

## ทำอะไร

ตารางระดับระบบ (ทีม Friday เขียน · ลูกค้าอ่านผ่าน API) และระดับลูกค้า (มี `workspace_id` เปิด RLS ตามปกติ)

- **Changelog (01):** `changelog_entries` (หัวข้อ สรุป เนื้อหา markdown ประเภท new · improved · fixed · รูป ปุ่ม "ลองใช้" กลุ่มผู้เห็น all · plans · flag · admins + ค่า · spotlight · สถานะ draft · scheduled · published · hidden · เวลาเผยแพร่ · ฉบับอังกฤษ) · `changelog_stats` (นับเห็น / คลิกต่อรายการ ไม่เก็บว่าใครอ่าน) · `user_ui_state` หรือคอลัมน์ใน `user_prefs`: เวลาที่เปิดแผงล่าสุด, spotlight ที่เห็นแล้ว
- **NPS (01):** `nps_settings` (แถวเดียว ตาม U5) · `nps_responses` (workspace_id, user_id null ได้, role, plan, score 0–10 null = ปิดโดยไม่ตอบ, comment, topics[], follow_up_status, ticket_id, note, created_at) · ผู้ใช้ลบบัญชีแล้ว user_id เป็น null (05 ข้อ 3)
- **Onboarding (02):** `onboarding_progress` (workspace_id, version, step, done_at) · `onboarding_dismissals` (user_id, workspace_id, hidden_at, never) · `onboarding_steps` (เวอร์ชัน ลำดับ ข้อความ ปุ่ม เปิด / ปิด · เฉพาะเมื่อผู้ใช้เลือกให้แก้จาก Ops ดู O34) · `onboarding_followups` (ทีม Friday ติดตาม: ผู้ติดตาม อีเมลที่ส่ง บันทึก)
- **ศูนย์ช่วยเหลือ (03):** `help_categories` · `help_articles` (slug, หมวด, สถานะ, ใครเห็น public · signed_in, หน้าในแอปที่เกี่ยวข้อง[], คำค้นเพิ่ม, review_at, ฉบับอังกฤษ, คอลัมน์ tsvector) · `help_article_versions` · `help_feedback` (article, helpful, comment · ไม่เก็บ user) · `help_search_misses` (ข้อความที่ตัดข้อมูลส่วนตัวแล้ว, จำนวน, วัน) · `help_article_tickets` (บทความ ↔ Ticket)
- **ผูก Ticket กับงาน (04):** `dev_issue_links` (issue_key, issue_id ภายนอก, หัวข้อ, ความรุนแรง, สถานะล่าสุด, resolution, released_at, synced_at) · `dev_issue_tickets` (link ↔ ticket, notified_at) · `dev_bridge_settings` (URL, token แบบเข้ารหัส, webhook secret แบบเข้ารหัส, การจับคู่ค่า)
- RLS: ตารางระบบทั้งหมด `ops_only` สำหรับ `friday_app` ยกเว้นที่ API ลูกค้าต้องอ่าน (changelog ที่เผยแพร่, help ที่เผยแพร่, nps_settings) ให้อ่านผ่าน view หรือ grant SELECT เฉพาะแถวที่เผยแพร่ · `nps_responses`, `onboarding_*` ของลูกค้าเปิด RLS ตาม workspace

## เสร็จเมื่อ

- [ ] migration + snapshot · RLS และ grant ครบ · `pnpm db:migrate` บนฐานข้อมูลทดสอบเดิมผ่าน
- [ ] test ของ `packages/db` ตรวจ RLS (ลูกค้าอ่านบทความร่างไม่ได้ · อ่าน NPS ของ Workspace อื่นไม่ได้) · typecheck / test ผ่าน
- [ ] build และ deploy Docker API และ ops ในเครื่องตาม CLAUDE.md แล้วตรวจว่าของเดิมยังทำงาน

## ยังต้องตัดสินใจ

**ผู้ใช้ตัดสินแล้ว (12 พ.ย. 2569): ใช้ตามคำแนะนำทุกข้อ** · ข้อความ "แนะนำ" ด้านล่างคือคำตัดสิน

- **ระยะเก็บคำตอบ NPS และคำค้นที่ไม่พบ** · **แนะนำ:** 25 เดือนเท่า `product_events` (เทียบปีต่อปีได้) แล้วลบด้วยงานเบื้องหลัง
- **แยก DB เป็นงานต่อฟีเจอร์หรือรวม** · **แนะนำ:** รวมในงานนี้แต่ทำเฉพาะไฟล์ที่อนุมัติ เพราะ `packages/db/**` เป็น lane เดียวกัน ทำพร้อมกันหลายงานไม่ได้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน -->
