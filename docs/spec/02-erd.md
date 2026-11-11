# 02 · ERD

แบ่งเป็น 6 แผนภาพตามกลุ่มของ [01-entities.md](01-entities.md) · แสดงเฉพาะ PK / FK และฟิลด์ที่ช่วยอ่านความสัมพันธ์ ฟิลด์ครบอยู่ในไฟล์ 01

GitHub แสดงแผนภาพ Mermaid ให้อัตโนมัติ

**ภาพรวม:** ผู้ใช้ 1 คน (`user`) อยู่ได้หลาย Workspace ผ่าน `workspace_member` · ข้อมูลงานทั้งหมดอยู่ใต้ `workspace` › `project` › `issue` และทุกตารางของลูกค้ามี `workspace_id` สำหรับ RLS (ในแผนภาพละไว้เพื่อให้อ่านง่าย)

## 1. ผู้ใช้, Workspace และสมาชิก

```mermaid
erDiagram
    user ||--o{ user_identity : "ล็อกอินได้หลายวิธี"
    user ||--o| mfa_factor : ""
    user ||--o{ user_session : ""
    user ||--o| line_binding : ""
    user ||--o{ workspace_member : "อยู่หลาย Workspace"
    workspace ||--o{ workspace_member : ""
    workspace ||--|| workspace_setting : ""
    workspace ||--|| security_policy : ""
    workspace ||--o{ invitation : ""
    workspace ||--o{ invite_link : ""
    workspace ||--o{ access_request : ""
    workspace ||--o{ team : ""
    team ||--o{ team_member : ""
    user ||--o{ team_member : ""
    user ||--o{ leave : ""
    workspace ||--o{ project_template : ""
    workspace ||--o{ sso_connection : ""
    sso_connection ||--o{ user_identity : ""
    workspace ||--o{ holiday_calendar : "ปฏิทินบริษัท"
    holiday_calendar ||--o{ holiday : ""

    user {
        uuid id PK
        text email UK
        text display_name
        text password_hash "null ได้"
        text locale
        text year_format
    }
    user_identity {
        uuid id PK
        uuid user_id FK
        text provider "password google microsoft saml oidc"
        text provider_subject
        uuid sso_connection_id FK
    }
    workspace {
        uuid id PK
        text slug UK
        text name
        text data_region
        text status
    }
    workspace_member {
        uuid workspace_id PK, FK
        uuid user_id PK, FK
        text role "owner admin member guest"
        text status
        int capacity_hours_week
    }
    invitation {
        uuid id PK
        uuid workspace_id FK
        text email
        text workspace_role
        uuid project_id FK "ไม่บังคับ"
        text project_role
        text status
    }
    holiday_calendar {
        uuid id PK
        uuid workspace_id FK "null = ธปท. ของระบบ"
        text source
    }
    holiday {
        uuid id PK
        uuid calendar_id FK
        date date
        text name
    }
```

## 2. โปรเจกต์และโครงสร้างแผน

```mermaid
erDiagram
    workspace ||--o{ project : ""
    project_template |o--o{ project : "สร้างจาก"
    holiday_calendar |o--o{ project : "ใช้ปฏิทิน"
    project ||--o{ project_holiday : ""
    project ||--o{ project_key_alias : ""
    project ||--o{ project_scope_item : ""
    project ||--o{ project_member : ""
    user ||--o{ project_member : ""
    project ||--o{ project_role_permission : ""
    project ||--o{ module : ""
    module ||--o{ phase : "กลุ่มงาน"
    project ||--o{ milestone : ""
    project ||--o{ sprint : ""
    sprint ||--o{ sprint_daily_snapshot : ""
    project ||--o{ issue_type : ""
    project ||--o{ workflow : ""
    workflow ||--o{ workflow_status : ""
    workflow ||--o{ workflow_rule : ""
    workflow ||--o{ issue_type : "ใช้ Workflow"
    project ||--o{ label : ""
    project ||--o{ custom_field : ""

    project {
        uuid id PK
        uuid workspace_id FK
        text key "UK ต่อ Workspace"
        text name
        date start_date
        date golive_date
        uuid owner_user_id FK
        text visibility
        int sprint_length_weeks
        bool time_log_enabled
        int issue_seq
    }
    project_member {
        uuid project_id PK, FK
        uuid user_id PK, FK
        text role "admin member viewer"
        text position
        int capacity_hours_week
    }
    module {
        uuid id PK
        uuid project_id FK
        text name
        uuid owner_user_id FK "Dev หลัก"
        int sort
    }
    phase {
        uuid id PK
        uuid module_id FK
        text name "จากคอลัมน์ Sprint ใน Excel"
    }
    sprint {
        uuid id PK
        uuid project_id FK
        int number
        date start_date
        date end_date
        text status
    }
    workflow_status {
        uuid id PK
        uuid workflow_id FK
        text name
        text category "todo in_progress review blocked done cancelled"
        text color "#RRGGBB หรือ null"
        uuid board_column_id FK "คอลัมน์บน Kanban"
        int wip_limit
    }
    issue_type {
        uuid id PK
        uuid project_id FK
        text name "Story Task Bug Spike"
        uuid workflow_id FK
        text_array required_fields
    }
```

## 3. งาน (Issue)

```mermaid
erDiagram
    project ||--o{ issue : ""
    issue_type ||--o{ issue : ""
    workflow_status ||--o{ issue : "สถานะ"
    module |o--o{ issue : ""
    phase |o--o{ issue : ""
    sprint |o--o{ issue : ""
    issue |o--o{ issue : "Task แม่ › Sub-task (ลึกสุด 2 ชั้น)"
    issue ||--o{ issue_assignee : "Dev หลายคน"
    user ||--o{ issue_assignee : ""
    issue ||--o{ issue_watcher : ""
    issue ||--o{ issue_label : ""
    label ||--o{ issue_label : ""
    issue ||--o{ issue_requirement : ""
    requirement ||--o{ issue_requirement : "FR / NFR"
    issue ||--o{ issue_screen : ""
    screen ||--o{ issue_screen : "SCR-xxx"
    issue ||--o{ issue_dependency : "predecessor"
    issue ||--o{ issue_dependency : "successor"
    issue ||--o{ checklist_item : ""
    issue ||--o{ comment : ""
    comment ||--o{ comment_mention : ""
    issue ||--o{ activity : ""
    issue ||--o{ time_log : ""
    issue ||--o{ test_run : ""
    test_run |o--o{ issue : "Bug ที่พบจากรอบนี้"
    issue ||--o{ due_change_request : ""
    issue ||--o{ issue_custom_value : ""
    custom_field ||--o{ issue_custom_value : ""
    milestone ||--o{ milestone_issue : ""
    issue ||--o{ milestone_issue : ""

    issue {
        uuid id PK
        uuid project_id FK
        int number "UK ต่อโปรเจกต์ (DP-39)"
        uuid issue_type_id FK
        uuid parent_id FK "null = ระดับ Task"
        uuid module_id FK
        uuid phase_id FK
        uuid sprint_id FK
        uuid status_id FK
        text title
        text priority
        uuid ba_id FK
        uuid reviewer_id FK
        uuid tester_id FK
        text size "XS S M L XL"
        numeric estimate_md "ของทั้งทีม"
        date plan_start
        date plan_end "= Due"
        date actual_start
        date actual_end
        text severity "เฉพาะ Bug"
        uuid found_in_test_run_id FK
        jsonb details "ฟิลด์ตามประเภท"
        int excel_row_no
        text rank
        int version
    }
    issue_dependency {
        uuid predecessor_id PK, FK
        uuid successor_id PK, FK
        text type "FS SS FF SF"
        int lag_days
    }
    test_run {
        uuid id PK
        uuid issue_id FK
        int run_no
        text result "passed failed blocked"
        text environment
        text commit_sha
        uuid tester_id FK
    }
    due_change_request {
        uuid id PK
        uuid issue_id FK
        uuid requester_id FK
        date current_due
        date requested_due
        text reason_code
        text status
        uuid decided_by FK
        text decided_via "in_app line email"
    }
```

## 4. แผน, ไฟล์ และ Git

```mermaid
erDiagram
    project ||--o{ plan_baseline : "v1 v2 ..."
    plan_baseline ||--o{ baseline_item : ""
    issue ||--o{ baseline_item : ""
    project ||--o{ plan_change : "การแก้ไขแผน"
    issue ||--o{ plan_change : ""
    plan_baseline |o--o{ plan_change : "เทียบกับ"
    project ||--o{ import_job : ""
    file |o--o{ import_job : "ไฟล์ Excel"

    project ||--o{ folder : ""
    folder |o--o{ folder : "โฟลเดอร์ย่อย"
    folder |o--o{ file : ""
    file ||--o{ file_version : ""
    file ||--o{ file_attachment : "ผูกกับ issue test_run comment project"

    workspace ||--o{ git_installation : ""
    git_installation ||--o{ git_repository : ""
    project ||--o{ project_repository : ""
    git_repository ||--o{ project_repository : ""
    git_repository ||--o{ git_commit : ""
    git_repository ||--o{ pull_request : ""
    issue ||--o{ issue_git_link : ""
    git_commit |o--o{ issue_git_link : ""
    pull_request |o--o{ issue_git_link : ""

    plan_baseline {
        uuid id PK
        uuid project_id FK
        int version
        text source "import manual"
    }
    plan_change {
        uuid id PK
        uuid issue_id FK
        uuid baseline_id FK
        text field
        jsonb old_value
        jsonb new_value
        text reason
        text source "manual import due_request"
    }
    file {
        uuid id PK
        uuid project_id FK
        uuid folder_id FK
        text kind "upload link"
        uuid current_version_id FK
        timestamptz deleted_at
    }
    file_attachment {
        uuid file_id FK
        text target_type
        uuid target_id
    }
    issue_git_link {
        uuid issue_id FK
        uuid commit_id FK
        uuid pull_request_id FK
        text link_source "branch message title manual"
    }
```

## 5. แจ้งเตือน, Automation และ Audit

```mermaid
erDiagram
    user ||--o{ notification : "ผู้รับ"
    issue |o--o{ notification : ""
    notification |o--o{ notification_delivery : "ส่งออกนอกแอป"
    user ||--o{ user_notification_pref : "เหตุการณ์ x ช่องทาง"
    user ||--o{ user_notification_setting : "ต่อ Workspace"
    workspace ||--o| line_oa_config : ""
    workspace ||--o{ line_group : ""
    workspace ||--o| email_sender_config : ""
    workspace ||--o{ webhook_endpoint : ""
    project ||--o{ project_notification_rule : ""
    line_group |o--o{ project_notification_rule : ""
    webhook_endpoint |o--o{ project_notification_rule : ""
    project ||--o| project_notification_setting : ""
    project ||--o{ report_schedule : ""

    project ||--o{ automation_rule : ""
    automation_rule ||--o{ automation_run : ""
    project ||--o{ saved_view : ""
    workspace ||--o{ api_token : ""

    workspace ||--o{ audit_log : "append-only"
    workspace ||--o{ data_subject_request : "PDPA"
    workspace ||--o{ workspace_export : ""

    notification {
        uuid id PK
        uuid recipient_id FK
        text event_type
        uuid issue_id FK
        text reason
        timestamptz read_at
        timestamptz snoozed_until
    }
    notification_delivery {
        uuid id PK
        uuid notification_id FK
        text channel "email line line_group webhook"
        text status
        int attempts
    }
    project_notification_rule {
        uuid project_id FK
        text event_type
        uuid line_group_id FK
        uuid webhook_id FK
    }
    automation_rule {
        uuid id PK
        uuid project_id FK
        text trigger
        jsonb conditions
        jsonb actions
        bool enabled
    }
    audit_log {
        uuid id PK
        uuid workspace_id FK
        uuid actor_id
        text actor_kind "user system friday_staff"
        text category
        text action
        text target_type
        uuid target_id
        inet ip
    }
```

## 6. SaaS และหลังบ้านทีม Friday

```mermaid
erDiagram
    plan ||--o{ subscription : ""
    workspace ||--o| subscription : ""
    workspace ||--o| billing_profile : ""
    subscription ||--o{ invoice : ""
    invoice ||--o{ payment : ""
    invoice ||--o{ tax_document : "e-Tax"
    invoice ||--o{ wht_certificate : "50 ทวิ"
    legal_document ||--o{ legal_acceptance : ""
    user ||--o{ legal_acceptance : ""

    workspace ||--o{ support_access_grant : "ลูกค้าเปิดสิทธิ์"
    workspace ||--o{ support_session : ""
    staff_user ||--o{ support_session : ""
    staff_user |o--o{ support_session : "ผู้อนุมัติคนที่ 2"
    feature_flag ||--o{ feature_flag_override : ""
    workspace ||--o{ feature_flag_override : ""

    plan {
        uuid id PK
        text code "free team_s team_m team_l enterprise"
        int seat_limit
        jsonb features
    }
    subscription {
        uuid id PK
        uuid workspace_id FK
        uuid plan_id FK
        text status "trialing active past_due canceled"
        text payment_method "card promptpay transfer"
        date trial_ends_at
    }
    invoice {
        uuid id PK
        text number
        bigint subtotal
        bigint vat
        bigint wht_amount
        bigint amount_due
        text status
    }
    support_session {
        uuid id PK
        uuid workspace_id FK
        uuid staff_id FK
        text ticket_no
        text mode "read write"
        timestamptz started_at
        timestamptz ended_at
    }
```
