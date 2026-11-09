# 01 · รายการ Entity

ถอดจากหน้าจอ UI v1.0 (51 หน้าใน `design/canvas/`) · คอลัมน์ "หน้าจอ" อ้างรหัสหน้าบน Canvas เช่น `C` = Task Detail, `L2` = Project Settings

ดูความสัมพันธ์ทั้งหมดใน [02-erd.md](02-erd.md) · คำตัดสินด้านข้อมูลอยู่ใน [README.md](README.md#คำตัดสินด้านข้อมูล-5-พย-2569)

**สถานะ:** หมวด A–H, J (เฉพาะ `notification`) และ L (เฉพาะ `audit_log`) สร้างแล้วใน `packages/db` (migration 0000–0004) · หมวดอื่นจะตามมาใน migration ถัดไป · ชื่อตารางในฐานข้อมูลเป็นพหูพจน์ (`issue` → `issues`)

## ธรรมเนียมทุกตาราง

| เรื่อง | กติกา |
|---|---|
| Primary key | `id uuid` (UUID v7 เรียงตามเวลาได้) · ไม่ใช้เลขรันเป็น PK |
| Multi-tenant | ทุกตารางของลูกค้ามี `workspace_id` และเปิด **Row-Level Security** ของ PostgreSQL ตาม `app.workspace_id` ที่ API ตั้งต่อคำขอ |
| เวลา | `created_at`, `updated_at` เป็น `timestamptz` · วันที่ในแผน (Plan Start / End, Due, วันหยุด) เป็น `date` ไม่มี timezone |
| ลบ | ตารางที่มีถังขยะ 30 วันใช้ `deleted_at` (soft delete) · ตารางอื่นลบจริง |
| แก้พร้อมกัน | ตารางที่แก้จากหลายคนพร้อมกัน (issue, project) มี `version int` ใช้ตรวจชนกัน (หน้า M1 › REALTIME) |
| เงิน | เก็บเป็นสตางค์ `bigint` ไม่ใช้ float |
| Man-Day | `numeric(6,2)` รองรับ 0.25 MD |
| ความลับ | Token / secret / URL ของ Webhook เข้ารหัสก่อนเก็บ (`*_enc`) · รหัสผ่านและ token ที่ส่งทางลิงก์เก็บเป็น hash |

**ข้อมูลระดับระบบ (ไม่มี `workspace_id`):** ผู้ใช้, วิธีล็อกอิน, แพ็กเกจ, ปฏิทินวันหยุด ธปท., เอกสารกฎหมาย, ทีม Friday (Super Admin)

---

## A. บัญชีผู้ใช้และการล็อกอิน (ระดับระบบ)

บัญชีเดียวอยู่ได้หลาย Workspace (Q1) จึงแยกข้อมูลส่วนตัวออกจากข้อมูลในแต่ละ Workspace

| Entity | ใช้ทำอะไร | ฟิลด์หลัก | หน้าจอ |
|---|---|---|---|
| `user` | บัญชีผู้ใช้ 1 คน | email (unique), email_verified_at, display_name, first_name, last_name, phone, avatar_url, about, locale (th/en), year_format (BE/CE), timezone, password_hash (null ถ้าใช้แค่ Google), password_changed_at, failed_login_count, locked_until, disabled_at | J1–J3, I |
| `user_identity` | วิธีล็อกอินที่ผูกกับบัญชี · 1 คนผูกได้หลายวิธี (ตามที่ตกลงไว้ว่าทำ SAML ทีหลัง) | user_id, provider (password · google · microsoft · saml · oidc), provider_subject, sso_connection_id (null ถ้าไม่ใช่ SSO) | J1, I |
| `mfa_factor` | 2FA แบบ Authenticator | user_id, type (totp), secret_enc, backup_codes_hash[], enabled_at | J1, I |
| `user_session` | อุปกรณ์ที่ล็อกอินอยู่ · ออกจากระบบรายเครื่องได้ | user_id, token_hash, device_name, user_agent, ip, location, remember_until (30 วัน), mfa_trusted_until, last_seen_at, revoked_at | I, M1 |
| `auth_token` | รหัส/ลิงก์ที่ใช้ครั้งเดียว | user_id, purpose (verify_email · reset_password · change_email), token_hash, new_email (เมื่อเปลี่ยนอีเมล), expires_at, used_at | J2, J3 |
| `line_binding` | ผูก LINE ส่วนตัว · 1 บัญชี LINE ต่อ 1 ผู้ใช้ | user_id (unique), line_user_id (unique), line_display_name, bound_at, unbound_at, unbound_by (Admin ยกเลิกให้ได้) | I |
| `line_link_code` | รหัส 6 หลักที่พิมพ์ในแชต OA (หมดอายุ 10 นาที) | user_id, code, expires_at, used_at | I |
| `calendar_feed_token` | ลิงก์ iCal / Google Calendar ส่วนตัว | user_id, workspace_id, project_id (null = ทุกโปรเจกต์), token_hash, revoked_at | 6 |

## B. Workspace และสมาชิก

| Entity | ใช้ทำอะไร | ฟิลด์หลัก | หน้าจอ |
|---|---|---|---|
| `workspace` | องค์กร 1 แห่ง = 1 tenant | slug (friday.app/**slug**, unique), name, logo_url, data_region, default_locale, allow_domain_join, status (trial · active · suspended · pending_delete), deleted_at | J5, Q1, N1 |
| `workspace_setting` | ค่าตั้งของ Workspace (1:1) | work_start (09:30), work_end (18:30), work_days, holiday_calendar_id (ปฏิทินหลัก), size_md_map (`{XS:1,S:3,M:5,L:8,XL:12}`), allow_project_override, safe_mode, trash_days (30/90), archive_retention_years, require_consent_on_first_login | N1 |
| `security_policy` | นโยบายความปลอดภัย (1:1) | password_min_length, password_require_special, password_rotation_days, lockout_attempts, lockout_minutes, session_idle_hours, mfa_enforcement (none · admin · all), allowed_email_domains[], ip_allowlist[] | N1 |
| `workspace_member` | การเป็นสมาชิกของ 1 คนใน 1 Workspace | workspace_id, user_id, role (owner · admin · member · guest), status (active · deactivated), job_title, department, capacity_hours_week (เวลาทั้งหมดของคน), work_start, work_end, work_days, last_active_at, joined_at · **Guest ไม่นับ Seat** | H, I |
| `invitation` | คำเชิญทางอีเมล | workspace_id, email, workspace_role, project_id, project_role, job_title, capacity_hours_week, message, token_hash, expires_at, invited_by, status (pending · accepted · declined · revoked · expired), accepted_user_id | H, 7, J4 |
| `invite_link` | ลิงก์เชิญที่แชร์ได้ (หมดอายุ 1 / 7 / 30 วัน) | workspace_id, token_hash, role, expires_at, created_by, revoked_at | H, J5 |
| `access_request` | ขอเข้าร่วม Workspace (อีเมลโดเมนเดียวกัน) หรือขอสิทธิ์เข้าโปรเจกต์ (หน้า 403) | workspace_id, user_id, project_id (null = ขอเข้า Workspace), status, decided_by, decided_at | J2, M1 |
| `team` | ทีมในองค์กร ใช้กรอง Workload และเพิ่มทั้งทีมเข้าโปรเจกต์ | workspace_id, name, color, lead_user_id | N1 |
| `team_member` | | team_id, user_id | N1 |
| `leave` | วันลา · ลด capacity ใน Workload | workspace_id, user_id, leave_type, start_date, end_date, half_day (am · pm), status (pending · approved), source (manual · hr) , external_ref | I, 6, 7 |
| `sso_connection` | SSO ขององค์กร (Enterprise · **ทำทีหลัง** แต่สร้างตารางไว้ตั้งแต่แรก) | workspace_id, type (entra · google_workspace · saml · oidc), config_enc, enforced, enabled_at | N1, Q1 |
| `verified_domain` | โดเมนที่ยืนยันผ่าน DNS TXT · ใช้บังคับ SSO และให้คนในโดเมนขอเข้าร่วม | workspace_id, domain, dns_token, verified_at | N1, J5 |
| `project_template` | แม่แบบโปรเจกต์ขององค์กร | workspace_id, name, description, config (jsonb: issue types, workflow, sprint, custom fields), usage_count | N1, A |

## C. ปฏิทินวันหยุด

| Entity | ใช้ทำอะไร | ฟิลด์หลัก | หน้าจอ |
|---|---|---|---|
| `holiday_calendar` | ชุดวันหยุด · ของระบบ (ธปท.) ใช้ร่วมทุก Workspace | workspace_id (null = ของระบบ), name, source (bot · custom) | N1, A, L2 |
| `holiday` | วันหยุด 1 วัน | calendar_id, date, name, kind (bank · company) | N1, A, 6 |

Workspace เลือกปฏิทินหลัก + เพิ่มวันหยุดบริษัท · โปรเจกต์ใช้ของ Workspace + เพิ่มวันหยุดเฉพาะโปรเจกต์ได้ (เช่น 31 ธ.ค. Company outing) · เมื่อวันหยุดเปลี่ยน ระบบคำนวณ Plan End ใหม่

## D. โปรเจกต์และโครงสร้างแผน

| Entity | ใช้ทำอะไร | ฟิลด์หลัก | หน้าจอ |
|---|---|---|---|
| `project` | โปรเจกต์ | workspace_id, key (DP), name, client_name, description, color, icon, template_id, start_date, golive_date, timezone, visibility (private · workspace), owner_user_id, status (planning · active · archived), estimate_unit (man_day · hour), progress_method (count · weighted), sprint_length_weeks (null = ไม่ใช้ Sprint), holiday_calendar_id, work_start/end (override), size_md_map (override), time_log_enabled (ค่าเริ่มต้น false), issue_seq (เลขงานล่าสุด), budget_satang, hourly_rate_satang, archived_at, deleted_at, version | A, L2, 1 |
| `project_key_alias` | Key เดิมหลังเปลี่ยน Key · ใช้ redirect ลิงก์เก่า | project_id, old_key | L2 |
| `project_scope_item` | In-scope, Out-of-scope, Deliverables, Acceptance criteria, สมมติฐาน | project_id, kind, text, sort | A, 1 |
| `project_holiday` | วันหยุดเฉพาะโปรเจกต์ | project_id, date, name | A, L2 |
| `project_member` | สมาชิกในโปรเจกต์ | project_id, user_id, role (admin · member · viewer), position (PM · UX/UI · Frontend · Backend · QA · BA), capacity_hours_week (เฉพาะชั่วโมงที่ให้โปรเจกต์นี้), pm_deputy (ทำแทน PM: รับแจ้งเตือนแบบ PM และอนุมัติคำขอเลื่อน Due · 9 พ.ย. 2569), joined_at | A, 7 |
| `project_role_permission` | ตารางสิทธิ์ที่ปรับได้รายโปรเจกต์ (เก็บเฉพาะค่าที่ต่างจากค่าเริ่มต้น) | project_id, role (member · viewer), permission (เช่น `issue.change_due_directly`), allowed | L2 |
| `module` | Module ในโปรเจกต์ | project_id, name, color, owner_user_id (Dev หลัก), sort | A, L2, 2 |
| `phase` | **กลุ่ม (Group) ใน Module ไม่บังคับ** · Module → กลุ่ม → Task → Sub-task · Sub-task อยู่กลุ่มเดียวกับ Task แม่ (ย้าย Task แล้ว Sub-task ตาม) · ในหน้าจอเรียกว่า "กลุ่ม" (ผู้ใช้ขอ 8 พ.ย. 2569) |
| `milestone` | Milestone บน Timeline / Gantt | project_id, module_id (ไม่บังคับ), name, date | A, 1, 4 |
| `milestone_issue` | งานที่ผูกกับ Milestone (ใช้คิด % ของ Milestone) | milestone_id, issue_id | 1 |
| `sprint` | Sprint ระดับโปรเจกต์ | project_id, number, name, start_date, end_date, goal, status (planning · active · completed), retrospective, completed_at, completed_by | L1 |
| `sprint_daily_snapshot` | ค่าประจำวันสำหรับวาดเส้น "จริง" ของ Burndown | sprint_id, date, remaining_md, done_md, issue_count, done_count | L1 |

## E. ประเภทงาน, Workflow และฟิลด์

| Entity | ใช้ทำอะไร | ฟิลด์หลัก | หน้าจอ |
|---|---|---|---|
| `issue_type` | Story / Task / Bug / Spike · เปิดปิดได้ | project_id, name, color, icon, workflow_id, required_fields[], enabled, sort | L2, K1 |
| `workflow` | ชุดสถานะ · Bug มี Workflow ของตัวเอง (Open → Closed) | project_id, name | L2 |
| `workflow_status` | สถานะ 1 ตัว | workflow_id, name, category (todo · in_progress · done), board_column_id (คอลัมน์บน Kanban: ชี้ไปสถานะของ Workflow มาตรฐาน · null = เป็นคอลัมน์เอง), wip_limit, sort | L2, 3 |
| `workflow_rule` | กฎการย้ายสถานะ เช่น "ห้ามย้ายไป Done ถ้า Sub-task ยังไม่ครบ" | workflow_id, rule_type, config (jsonb), enabled | A, L2 |
| `custom_field` | ฟิลด์ที่ทีมเพิ่มเอง (Customer request, Release version, Effort ทีมลูกค้า) | project_id, name, field_type (text · number · select · multi_select · user · date), options (jsonb), sort | L2 |
| `issue_custom_value` | ค่าของฟิลด์ข้างบน | issue_id, field_id, value (jsonb) | C |
| `label` | | project_id, name, color | L2 |

## F. งาน (Issue)

Task, Sub-task, Story, Bug และ Spike อยู่ใน**ตารางเดียว** · `issue_type` บอกประเภท ส่วน `parent_id` บอกระดับในลำดับชั้น (ตามคำตัดสินว่า "ประเภทแยกจากลำดับชั้น")

| Entity | ใช้ทำอะไร | ฟิลด์หลัก | หน้าจอ |
|---|---|---|---|
| `issue` | งาน 1 รายการ | ดูรายละเอียดด้านล่าง | 2–6, B, C, D, K1, K2 |
| `issue_assignee` | Dev / Assignee หลายคน · Man-Day แบ่งเท่ากันตอนคิด Workload | issue_id, user_id, sort | B, C |
| `issue_watcher` | ผู้ติดตาม | issue_id, user_id, source (manual · auto_create · auto_comment · auto_mention) | C, I |
| `issue_label` | | issue_id, label_id | C |
| `requirement` | FR / NFR · สร้างอัตโนมัติเมื่อถูกอ้างถึง · นำเข้าจาก SRS ทีหลังได้ | project_id, code (FR-06.2), kind (FR · NFR), title, source_file_id | B, O2 |
| `issue_requirement` | | issue_id, requirement_id | B, O2 |
| `screen` | Screen ID | project_id, code (SCR-107), name | B, O2 |
| `issue_screen` | | issue_id, screen_id | B, O2 |
| `issue_dependency` | Dependency ใน Gantt | predecessor_id, successor_id, type (FS · SS · FF · SF), lag_days | B, C, 5 |
| `checklist_item` | Checklist และ Acceptance criteria | issue_id, kind (checklist · acceptance), text, done, done_by, done_at, sort | C, D, K1 |
| `comment` | คอมเมนต์ · รองรับ @mention | issue_id, author_id, body (markdown), edited_at, deleted_at, deleted_by (Admin ลบของคนอื่น) | C, D |
| `comment_mention` | ใช้ส่งแจ้งเตือนและหน้า Mentions | comment_id, user_id | G, E |
| `activity` | ประวัติทุกการเปลี่ยนแปลง (Activity ในงาน + Recent activity ของโปรเจกต์) | workspace_id, project_id, issue_id, actor_id, actor_kind (user · automation · git · import), verb, field, old_value, new_value (jsonb), created_at | C, 1 |
| `time_log` | บันทึกเวลา (เปิดเมื่อโปรเจกต์เปิด Time log) | issue_id, user_id, date, md, note | C, D |
| `test_run` | ผลทดสอบแต่ละรอบ | issue_id, run_no, result (passed · failed · blocked), passed_count, total_count, environment (SIT · UAT · Production), commit_sha, note, tester_id | D, M4 |
| `due_change_request` | คำขอเลื่อน Due | issue_id, requester_id, current_due, requested_due, reason_code, detail, impact (jsonb snapshot ตอนส่ง), status (pending · approved · rejected · cancelled), decided_by, decided_at, decided_via (in_app · line · email), decision_note (เหตุผลของผู้อนุมัติ / ปฏิเสธ · migration 0004) | K3, G |

### ฟิลด์ของ `issue`

| กลุ่ม | ฟิลด์ |
|---|---|
| ตัวตน | workspace_id, project_id, number (DP-**39** · นำเข้าจาก Excel ใช้คอลัมน์ **ID** ตามเลขงานใน Prototype), issue_type_id, parent_id (null = ระดับ Task), excel_row_no (คอลัมน์ **No.** ใช้จับคู่แถวตอน Import อัปเดต) |
| ตำแหน่งในแผน | module_id, phase_id, sprint_id, rank (ลำดับใน Backlog / Kanban แบบ LexoRank) |
| เนื้อหา | title, description (markdown), status_id, priority (urgent · high · medium · low) |
| คน | ba_id, reviewer_id, tester_id, reporter_id, created_by · Dev อยู่ใน `issue_assignee` |
| ประเมิน | size (XS–XL, null = ยังไม่ประเมิน), estimate_md (ของทั้งทีม), progress_pct (กรอกเองได้เฉพาะงานที่ไม่มีลูก) |
| วันที่ | plan_start, plan_end (= Due), actual_start, actual_end (บันทึกอัตโนมัติเมื่อสถานะเปลี่ยน), completed_at |
| Bug | severity (critical · major · minor), environment, reopen_count, found_in_test_run_id |
| ตามประเภท | details (jsonb): Bug = browser, found_in_commit, steps, expected, actual · Story = as_a, i_want, so_that · Spike = question, deliverables[], timebox_hours |
| อื่น ๆ | shared_with_guests (Guest เห็นงานนี้), deleted_at, version |

## G. แผนและการแก้ไขแผน

| Entity | ใช้ทำอะไร | ฟิลด์หลัก | หน้าจอ |
|---|---|---|---|
| `plan_baseline` | Baseline v1, v2 … | project_id, version, name, source (import · manual), created_by, created_at | L3, 5 |
| `baseline_item` | ค่าของแต่ละงานตอนตั้ง Baseline | baseline_id, issue_id, plan_start, plan_end, estimate_md, assignee_ids[] | 5, L3 |
| `plan_change` | แท็บ "การแก้ไขแผน" · การแก้หลังมี Baseline บันทึกทุกครั้ง · เหตุผลไม่บังคับ (ผู้ใช้ขอ 8 พ.ย. 2569: ไม่ต้องเตือน ให้ลง Activity ก็พอ) | project_id, issue_id, baseline_id, field, old_value, new_value, reason, impact, changed_by, changed_at, source (manual · import · due_request) | L3 |
| `import_job` | งานนำเข้า Excel | project_id (null = โปรเจกต์ใหม่), mode (create · update), file_name, storage_key, column_mapping (jsonb), person_mapping (jsonb), validation (jsonb: แถวที่ต้องแก้), status, row_total, row_imported, row_skipped, error, created_by, completed_at | L3 |

## H. ไฟล์

| Entity | ใช้ทำอะไร | ฟิลด์หลัก | หน้าจอ |
|---|---|---|---|
| `folder` | โฟลเดอร์ในหน้า Files | project_id, parent_id, name | 8 |
| `file` | ไฟล์หรือลิงก์ | workspace_id, project_id, folder_id, kind (upload · link), name, mime, size_bytes, link_url, link_provider (figma · gdrive · notion), current_version_id, uploaded_by, deleted_at | 8, C, D |
| `file_version` | Version history | file_id, version_no, storage_key (S3), size_bytes, note, uploaded_by | 8 |
| `file_attachment` | ไฟล์ผูกกับอะไร · 1 ไฟล์ผูกได้หลายที่ (เตือนก่อนลบไฟล์ที่เป็นหลักฐาน) | file_id, target_type (issue · test_run · comment · project · requirement), target_id, created_by | 8, C, D, P3 |

พื้นที่ใช้ของ Workspace = ผลรวม `file_version.size_bytes` ที่ยังไม่ถูกลบ (คำนวณ ไม่เก็บ)

## I. Git

| Entity | ใช้ทำอะไร | ฟิลด์หลัก | หน้าจอ |
|---|---|---|---|
| `git_installation` | GitHub App / GitLab ระดับ Workspace | workspace_id, provider (github · gitlab), account_name, external_installation_id, status | N1 |
| `git_repository` | | installation_id, full_name, default_branch | L2 |
| `project_repository` | ผูก repo กับโปรเจกต์ + กฎย้ายสถานะ | project_id, repository_id, branch_pattern, on_first_commit_status_id, on_pr_open_status_id, on_merge_status_id, notify_on_ci_fail | L2 |
| `git_commit` | | repository_id, sha, message, author_name, author_user_id, committed_at, url | C, D, K2 |
| `pull_request` | | repository_id, number, title, state (draft · open · merged · closed), source_branch, target_branch, ci_status, review_status, url | C, D |
| `issue_git_link` | ผูกอัตโนมัติเมื่อพบ DP-526 ในชื่อ branch / commit / PR | issue_id, commit_id, pull_request_id, link_source (branch · message · title · manual) | C, D |

## J. แจ้งเตือน

| Entity | ใช้ทำอะไร | ฟิลด์หลัก | หน้าจอ |
|---|---|---|---|
| `notification` | รายการใน Inbox / กระดิ่ง | workspace_id, recipient_id, event_type, actor_id, project_id, issue_id, payload (jsonb), reason ("ทำไมฉันได้รับแจ้ง"), read_at, done_at, snoozed_until | G, K4, E |
| `notification_delivery` | ข้อความที่ส่งออกนอกแอป · ใช้ทั้งส่งซ้ำและ Audit | workspace_id, notification_id, channel (email · line · line_group · webhook), target_ref, status (queued · sent · failed · skipped_quiet_hours), attempts, last_error, sent_at | N1, N2 |
| `user_notification_pref` | ตารางเหตุการณ์ × ช่องทางใน Profile | workspace_id, user_id, event_type, channel, enabled | I |
| `user_notification_setting` | ค่าอื่นของแต่ละคน | workspace_id, user_id, due_reminder (1d_and_today · 3d · today_only), digest (workdays · daily · off), quiet_start, quiet_end, quiet_on_holidays, auto_watch | I |
| `line_oa_config` | LINE OA ของ Workspace (1:1) | workspace_id, channel_id, channel_secret_enc, access_token_enc, fallback_to_email, batch_digest_minutes | N1 |
| `line_group` | กลุ่ม LINE ที่เชิญ OA เข้าไป | workspace_id, line_group_id, name, joined_at | N1, L2 |
| `email_sender_config` | โดเมนผู้ส่งขององค์กร (1:1) | workspace_id, from_name, from_email, reply_to, spf_ok, dkim_ok, dmarc_ok, verified_at | N1 |
| `webhook_endpoint` | Webhook ทั่วไป | workspace_id, name, format (discord · slack · teams · telegram · json), url_enc, signing_secret_enc, status, consecutive_failures, paused_until | N1 |
| `project_notification_rule` | เหตุการณ์ไหนส่งเข้ากลุ่มไหน | project_id, event_type, enabled, line_group_id, webhook_id | L2 |
| `project_notification_setting` | ช่วงเวลางดส่งเข้ากลุ่ม (1:1) | project_id, quiet_mode (after_hours · always_send), critical_bug_bypass | L2 |
| `report_schedule` | ส่งรายงานประจำสัปดาห์อัตโนมัติ | project_id, report_type, weekday, time, channels, recipients | O2 |

## K. Automation, มุมมอง และค้นหา

| Entity | ใช้ทำอะไร | ฟิลด์หลัก | หน้าจอ |
|---|---|---|---|
| `automation_rule` | เมื่อ … ถ้า … ให้ … | project_id, name, trigger (issue_created · status_changed · subtasks_done · overdue · test_attached · sprint_started · sprint_completed · schedule), trigger_config, conditions (jsonb), actions (jsonb), enabled, created_by | P2 |
| `automation_run` | ประวัติการทำงาน | rule_id, issue_ids[], result (success · skipped · failed · retried), detail, depth (กันวนซ้ำ ≤ 3 ชั้น), ran_at | P2 |
| `saved_view` | View ในหน้า Table (All tasks, Overdue …) | project_id, owner_id (null = แชร์ทั้งโปรเจกต์), name, view_type, filters, group_by, sort, columns (jsonb) | 2 |
| `saved_search` | การค้นหาที่บันทึกไว้ | workspace_id, user_id, name, query, filters | P1 |
| `api_token` | Token สำหรับเรียก API | workspace_id, name, token_hash, scopes[], created_by, last_used_at, revoked_at | N1 |

## L. Audit และ PDPA

| Entity | ใช้ทำอะไร | ฟิลด์หลัก | หน้าจอ |
|---|---|---|---|
| `audit_log` | บันทึกแก้ไขไม่ได้ (append-only) · Team เก็บ 1 ปี, Enterprise 7 ปี · แบ่ง partition รายเดือน | workspace_id, actor_id, actor_kind (user · system · friday_staff), category (perm · data · secu · plan · notify), action, target_type, target_id, summary, ip, user_agent, created_at | N1, Q3 |
| `data_subject_request` | คำขอจากเจ้าของข้อมูล (ลบ / ขอสำเนา) | workspace_id, requester_email, request_type (erase · export), due_date, status, handled_by, completed_at, result_file_id | N1 |
| `workspace_export` | Export ทั้ง Workspace | workspace_id, requested_by, status, file_key, expires_at | N1 |

## M. SaaS · แพ็กเกจและการชำระเงิน

| Entity | ใช้ทำอะไร | ฟิลด์หลัก | หน้าจอ |
|---|---|---|---|
| `plan` | แพ็กเกจ (ระดับระบบ) | code (free · team_s · team_m · team_l · enterprise), seat_limit, storage_gb_per_member, features (jsonb), price_monthly_satang, price_yearly_satang | R1, Q2 |
| `subscription` | แพ็กเกจของ Workspace | workspace_id, plan_id, cycle (monthly · yearly), status (trialing · active · past_due · canceled), trial_ends_at, current_period_start, current_period_end, payment_method (card · promptpay · transfer), stripe_customer_id, stripe_subscription_id, discount | N1, R2 |
| `billing_profile` | ข้อมูลออกใบกำกับภาษี (1:1) | workspace_id, company_name, tax_id, branch_type (head · branch), branch_no, address, tax_email, wht_enabled | N1, R2 |
| `invoice` | ใบแจ้งหนี้ | workspace_id, subscription_id, number, period_start, period_end, subtotal, vat, total, wht_amount, amount_due (สตางค์ทั้งหมด), po_number, status (open · pending_review · paid · void), due_date, paid_at | N1, R2, Q3 |
| `payment` | การชำระ | invoice_id, method, amount, provider_ref, slip_file_key, status (pending_review · confirmed · rejected), reviewed_by, reviewed_at | R2, Q3 |
| `tax_document` | e-Tax Invoice & e-Receipt | invoice_id, doc_type, number, provider_ref, status, sent_at | Q3 |
| `wht_certificate` | หนังสือรับรองหัก ณ ที่จ่าย (50 ทวิ) | invoice_id, file_key, uploaded_by, status, reviewed_by | R2, Q3 |
| `legal_document` | ข้อกำหนด, นโยบาย, DPA (ระดับระบบ) | doc_type, version, effective_at, summary | R4 |
| `legal_acceptance` | ใครรับทราบฉบับไหน | user_id, workspace_id, document_id, accepted_at, ip | R4, J2 |

## N. หลังบ้านทีม Friday (ระดับระบบ · แยกฐานสิทธิ์จากลูกค้า)

| Entity | ใช้ทำอะไร | ฟิลด์หลัก | หน้าจอ |
|---|---|---|---|
| `staff_user` | ทีม Friday · ล็อกอินด้วย Security key | email, name, role, webauthn_credentials | Q3 |
| `support_access_grant` | ลูกค้าเปิดสิทธิ์ให้ทีม Friday ล่วงหน้า | workspace_id, granted_by, until (null = จนกว่าจะปิด), max_mode (read · write), notify_admins | N1, Q3 |
| `support_session` | การเข้าบัญชีลูกค้าแต่ละครั้ง | workspace_id, staff_id, ticket_no, reason, mode, second_approver_id (โหมดแก้ไข), started_at, ended_at | Q3, N1 |
| `feature_flag` | | key, description, default_on | Q3 |
| `feature_flag_override` | เปิดให้บางลูกค้า | flag_id, workspace_id, enabled | Q3 |
| `announcement` | ประกาศถึงลูกค้า | message, audience (all · owners_admins), channels (banner · email), scheduled_at, sent_at | Q3 |

---

## ค่าที่คำนวณ ไม่เก็บในตาราง

| ค่า | คำนวณจาก | หน้าจอ |
|---|---|---|
| Progress ของ Task | Sub-task (ถ้ามี) ตาม `progress_method` ของโปรเจกต์ | C, 2 |
| Estimate ของ Task ที่มี Sub-task | ผลรวม Sub-task | B |
| Workload / Utilization | Man-Day กระจายเท่ากันตามวันทำการระหว่าง Plan Start–End ÷ จำนวน Dev · capacity หักวันหยุดและวันลา | 7, O1, N1 |
| Health (On track / At risk / Off track) | งานช้ากว่าแผน, Overdue, Workload เกิน capacity | 1, E |
| คาดการณ์วันจบของ Module | Man-Day ที่ปิดได้ต่อสัปดาห์ (ความเร็วจริง) | O2, L3 |
| Critical path และ Auto-schedule | `issue_dependency` + วันทำการ | 5 |
| Seats ที่ใช้ | `workspace_member` ที่ active และไม่ใช่ Guest | H, Q2 |
| พื้นที่ไฟล์ที่ใช้ | ผลรวม `file_version` | 8, N1 |

ถ้าคำนวณทุกครั้งช้าเกินไป (เช่น Workload รวมทุกโปรเจกต์ใน N1) ให้เก็บผลไว้ใน Redis / Valkey แล้วล้างเมื่องานเปลี่ยน ไม่ต้องสร้างตารางเพิ่ม

## กติกาข้อมูล (ต้องบังคับที่ API และ / หรือฐานข้อมูล)

1. **ลำดับชั้นลึกสุด 2 ระดับ:** `parent_id` ต้องชี้ไปงานที่ `parent_id IS NULL` เท่านั้น
2. **Task ต้องมี Module · Sub-task ต้องมี Task แม่** · Sub-task สืบทอด `module_id`, `phase_id`, `sprint_id` จากแม่ เมื่อย้ายแม่ต้องย้ายลูกตามในธุรกรรมเดียวกัน
3. **วันที่ของ Sub-task ต้องอยู่ในช่วงของ Task แม่**: เตือน ไม่บล็อก (หน้า B, M1)
4. **Plan Start ตรงวันหยุด** ให้เลื่อนไปวันทำงานถัดไป · Plan End = วันทำการที่ (Man-Day) นับ Plan Start เป็นวันแรก ตรงกับสูตร `WORKDAY(Plan Start-1, Man-Day, Holidays)` ในไฟล์แผน · **จำนวน Dev ไม่ทำให้วันจบเปลี่ยน** (Man-Day ของทีมแบ่งเท่ากันต่อคนเฉพาะตอนคิด Workload)
5. **เลขงานไม่ซ้ำในโปรเจกต์:** `UNIQUE (project_id, number)` · ออกเลขด้วย `UPDATE project SET issue_seq = issue_seq + 1 … RETURNING` ในธุรกรรมเดียวกับการสร้างงาน · ไม่นำเลขของงานที่ลบมาใช้ใหม่
6. **Project Key ไม่ซ้ำใน Workspace:** `UNIQUE (workspace_id, key)` และต้องไม่ชนกับ `project_key_alias`
7. **เปลี่ยน Due:** Member ต้องสร้าง `due_change_request` ถ้าสิทธิ์ `issue.change_due_directly` ปิดอยู่ · อนุมัติแล้วเขียน `plan_change` อัตโนมัติ
8. **แก้แผนหลังมี Baseline** (Plan Start, Plan End, Man-Day, Dev) ต้องมี `reason` และเขียน `plan_change`
9. **Actual Start / End** ตั้งอัตโนมัติเมื่อสถานะเข้าหมวด in_progress ครั้งแรก / เข้าหมวด done · ถ้า Reopen ให้ล้าง Actual End
10. **audit_log** ห้าม UPDATE / DELETE (สิทธิ์ฐานข้อมูลให้แค่ INSERT, SELECT) ลบได้เฉพาะ job ล้างข้อมูลตามระยะเก็บรักษาของแพ็กเกจ
