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

- [x] migration + snapshot · RLS และ grant ครบ · `pnpm db:migrate` บนฐานข้อมูลทดสอบเดิมผ่าน
- [x] test ของ `packages/db` ตรวจ RLS (ลูกค้าอ่านบทความร่างไม่ได้ · อ่าน NPS ของ Workspace อื่นไม่ได้) · typecheck / test ผ่าน
- [ ] build และ deploy Docker API และ ops ในเครื่องตาม CLAUDE.md แล้วตรวจว่าของเดิมยังทำงาน

## ยังต้องตัดสินใจ

**ผู้ใช้ตัดสินแล้ว (12 พ.ย. 2569): ใช้ตามคำแนะนำทุกข้อ** · ข้อความ "แนะนำ" ด้านล่างคือคำตัดสิน

- **ระยะเก็บคำตอบ NPS และคำค้นที่ไม่พบ** · **แนะนำ:** 25 เดือนเท่า `product_events` (เทียบปีต่อปีได้) แล้วลบด้วยงานเบื้องหลัง
- **แยก DB เป็นงานต่อฟีเจอร์หรือรวม** · **แนะนำ:** รวมในงานนี้แต่ทำเฉพาะไฟล์ที่อนุมัติ เพราะ `packages/db/**` เป็น lane เดียวกัน ทำพร้อมกันหลายงานไม่ได้

## บันทึกผล

ส่งงาน 12 พ.ย. 2569 · migration `0033_engagement_help` · schema ใน `packages/db/src/schema/engagement.ts` และ `help.ts` · ตาราง public รวม 166

**ตารางและผู้ใช้ (ดูฟิลด์ทั้งหมดใน 01-entities หมวด P)**

| ตาราง | ลูกค้า (`friday_app`) | ใช้โดย |
|---|---|---|
| `changelog_entries` | อ่านเฉพาะ published / scheduled ที่ `published_at <= now()` · กลุ่มผู้เห็นกรองที่ API | A42, O33, W24 |
| `changelog_stats` | ops_only · เพิ่มผ่าน `app.count_changelog_views(uuid[])`, `app.count_changelog_click(uuid)` (นับเฉพาะรายการที่เห็นได้และต้องเข้าสู่ระบบ) | A42, O33 |
| `user_ui_states` | ของตัวเอง (SELECT / INSERT / UPDATE) | A42 |
| `nps_settings` | อ่านได้ · มีแถวเริ่มต้นจาก migration ตามคำตัดสิน | A42, O33 |
| `nps_responses` | INSERT / SELECT เฉพาะแถวของตัวเองใน Workspace ปัจจุบัน และเฉพาะคอลัมน์ id, workspace_id, user_id, role, plan, score, comment, topics, created_at | A42, O33 |
| `onboarding_progress` | SELECT / INSERT ขั้นของ Workspace (user_id ว่าง) และขั้นส่วนตัวของตัวเอง · แก้ / ลบไม่ได้ | A43, O34 |
| `onboarding_dismissals` | ของตัวเอง (SELECT / INSERT / UPDATE) | A43 |
| `onboarding_followups` | ops_only | O34 |
| `help_categories` | อ่านได้ · seed 8 หมวดตาม X1 | A44, O35 |
| `help_articles` | อ่านเฉพาะ published · `signed_in` ต้องมี app.user_id · **grant รายคอลัมน์** (ไม่รวม draft, keywords, review_at, owner, source_ticket, pii_*, created_by / updated_by) จึงต้อง select คอลัมน์เอง ห้าม `select()` ทั้งแถว | A44, O35, W26 |
| `help_article_versions` | ops_only | O35 |
| `help_feedback` | INSERT อย่างเดียว เฉพาะบทความที่เห็น | A44, O35 |
| `help_article_views` | อ่านของบทความที่เห็น · เพิ่มผ่าน `app.record_help_view(uuid)` | A44, O35 |
| `help_search_stats` / `help_search_misses` | ops_only · เพิ่มผ่าน `app.record_help_search(text, found boolean)` · คำค้นผ่าน `app.help_search_key(text)` (ตัวพิมพ์เล็ก ตัดอีเมล / เบอร์โทร / เลขยาว ≤ 100 ตัว) | A44, O35 |
| `help_article_tickets` | ops_only (A44 เขียนผ่าน SYSTEM_DB พร้อมสร้าง Ticket) | A44, O35, O36 |
| `dev_issue_links` / `dev_issue_tickets` / `dev_bridge_settings` | ops_only | O36 |

**คำตัดสินและสิ่งที่ต่างจากข้อความงาน**
- ใช้ตามคำแนะนำทุกข้อ: เก็บ `nps_responses` และ `help_search_misses` 25 เดือนแล้วงานเบื้องหลังลบ (ยังไม่มี job · ให้ O33 ลบ NPS และ O35 ลบคำค้นผ่าน friday_worker) · รวม DB ของทุกฟีเจอร์ในงานนี้
- **ไม่สร้าง `onboarding_steps`** เพราะ O34 ตัดสินให้แก้ขั้นในไฟล์ของ API (ไม่ทำ V6) · `onboarding_progress.version` ใช้เลขเวอร์ชันชุดขั้นในโค้ด
- ค้นบทความใช้ `search_text` (generated: title + summary + keywords + ฉบับอังกฤษ + body) + GIN pg_trgm แทน tsvector เพราะ tsvector ของ PostgreSQL ตัดคำภาษาไทยไม่ได้ และ A44 กำหนดให้ "แบบเดียวกับ A22" (ILIKE / similarity)
- `keywords` เก็บเป็นข้อความคั่นจุลภาคตามที่พิมพ์ในตัวแก้ (generated column ใช้ array_to_string ไม่ได้)
- บทความที่เผยแพร่แล้วแก้ต่อใน `help_articles.draft` (jsonb) จนกดเผยแพร่ ลูกค้าไม่เห็นเพราะไม่ได้ grant คอลัมน์นี้ · เผยแพร่ต้องมี `pii_checked_at` (CHECK)
- Spotlight มีได้ทีละ 1 รายการในบรรดา scheduled / published (unique index) · ตั้งรายการใหม่ต้องปลด `spotlight` ของรายการเดิมในธุรกรรมเดียวกัน
- scheduled ที่ถึงเวลาแล้วลูกค้าเห็นทันทีผ่าน RLS ไม่ต้องมีงานเปลี่ยนสถานะ (O33 แสดงสถานะ "เผยแพร่" จากเวลาได้เลย)
- ชื่อ `onboarding_progress` และ `help_feedback` คงตามงาน (คำนามนับไม่ได้) · test entities รองรับชื่อเอกพจน์สองชื่อนี้

**เพิ่มให้งานถัดไป (ข้อความงานไม่ได้ระบุ)**
- `user_ui_states.nps_prompted_at` / `nps_responded_at` (A42 · ถาม ≤ 1 ครั้งต่อวัน และซ้ำทุก N วันต่อคนข้าม Workspace) · `spotlight_seen_at` (เงื่อนไข "วันที่เห็น Spotlight")
- `changelog_entries.dev_issue_link_id` (ร่าง "แก้ไข" จาก O36 · แสดง "มาจาก Ticket / FM-xxx") · `cta_*`, `media_*`, `show_public`, `display_date`, `hide_reason` ตาม U4 / U7
- `nps_responses.tags` (หัวข้อที่ทีมใส่ใน U6) แยกจาก `topics` (ลูกค้าเลือก) · `followed_up_by/at` · FK `ticket_id` รวม workspace_id
- `onboarding_dismissals.completion_seen_at` (V4 แสดงครั้งเดียว) · `onboarding_progress.meta` (เช่น "นำเข้า Excel 46 งาน" ใน V5)
- `help_article_views` (อ่าน 30 วัน / ยอดนิยม) · `help_search_stats` (ค้นหา 30 วัน) · `help_search_misses.tickets` และ `article_id` · `help_articles.owner_id`, `source_ticket_id`, `review_at`
- `dev_issue_tickets.outcome` (T9 / T10) และ `notified_at` · `dev_bridge_settings.token_hint`, `last_test_*`, `last_webhook_at`

**ตรวจแล้ว:** `packages/db/test/phase3.test.ts` (O32 19 ข้อ: ลูกค้าอ่านบทความร่าง / draft ไม่ได้ · บทความเฉพาะผู้เข้าสู่ระบบ · อ่าน NPS ของ Workspace อื่นและของคนอื่นไม่ได้ · ยอดนับผ่านฟังก์ชัน · Onboarding · ผูก Ticket) · entities test ตรวจว่าตาราง ops_only ไม่มีสิทธิ์ของ friday_app · `pnpm --filter @friday/db test` 163 ผ่าน · `pnpm typecheck` ผ่าน · `@friday/api` 685 ผ่าน · `@friday/ops-api` 162 ผ่าน บนฐาน `friday_p3db` · ยังไม่ได้ build / deploy Docker (ผู้ประสานงานทำต่อ)
