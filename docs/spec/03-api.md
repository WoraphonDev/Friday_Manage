# 03 · API

ถอดจากหน้าจอ UI v1.0.1 · ตารางและฟิลด์อ้างอิง [01-entities.md](01-entities.md) · ชื่อสิทธิ์ (`issue.edit` ฯลฯ) เป็นร่างที่จะกำหนดค่าเริ่มต้นของแต่ละ Role ในขั้นที่ 4

เอกสารแบ่งเป็น 3 ส่วน:
1. [ธรรมเนียมของ API](#1-ธรรมเนียมของ-api): ใช้กับทุก endpoint
2. [หน้าจอ → API](#2-หน้าจอ--api): แต่ละหน้าเรียกอะไร
3. [รายการ Endpoint](#3-รายการ-endpoint): สิทธิ์ที่ต้องใช้และ event ที่เกิดขึ้น · รายละเอียด request / response เขียนเฉพาะ endpoint ที่มีกติกาซับซ้อน ส่วนที่เหลือจะได้จาก OpenAPI ที่ NestJS สร้างจากโค้ด

---

## 1. ธรรมเนียมของ API

### URL

| ส่วน | รูปแบบ | ตัวอย่าง |
|---|---|---|
| ระดับผู้ใช้ (ไม่ผูก Workspace) | `/api/v1/...` | `/api/v1/me`, `/api/v1/auth/login` |
| ระดับ Workspace | `/api/v1/w/{workspace}/...` | `/api/v1/w/friday-dev/projects` |
| ระดับโปรเจกต์ | `/api/v1/w/{workspace}/projects/{projectKey}/...` | `.../projects/DP/sprints` |
| งาน | `/api/v1/w/{workspace}/issues/{issueKey}` | `.../issues/DP-39` |
| Webhook ขาเข้า | `/hooks/{provider}` | `/hooks/github`, `/hooks/line` |
| หลังบ้านทีม Friday | แยกโดเมนและแอป: `ops.friday.app/api/...` | ไม่ใช้ session ของลูกค้า |

- `{workspace}` คือ slug จาก URL ของหน้าเว็บ (Q1) · ทุกคำขอตรวจว่าผู้ใช้เป็นสมาชิกที่ active แล้วตั้ง `app.workspace_id` ให้ RLS ก่อนเข้าฐานข้อมูล
- อ้างโปรเจกต์ด้วย Key และงานด้วย Issue key ให้ตรงกับ URL ที่ผู้ใช้เห็น · ถ้าเป็น Key เก่าใน `project_key_alias` ตอบ `301` พร้อม Key ใหม่
- งานใช้ URL ระดับ Workspace (ไม่ซ้อนใต้โปรเจกต์) เพราะ Issue key บอกโปรเจกต์อยู่แล้ว และ Inbox / My Tasks / ค้นหา เรียกข้ามโปรเจกต์
- การกระทำที่เขียนในเอกสารนี้เป็น `:action` (เช่น `:archive`, `:join-as-admin`) ในโค้ดจริงใช้ path `/action` (เช่น `p/archive`) เพราะ Express 5 ใช้ `:` เป็นตัวแปรใน path

### การยืนยันตัวตน

| ผู้เรียก | วิธี |
|---|---|
| เว็บ | Session cookie (`HttpOnly`, `Secure`, `SameSite=Lax`) + CSRF token ใน header สำหรับคำขอที่แก้ข้อมูล |
| ระบบภายนอก | `Authorization: Bearer <api_token>` (N1 › API tokens) · สิทธิ์ตาม `scopes` ของ token |
| LINE ปุ่มอนุมัติ | Postback ของ LINE ไปที่ `/hooks/line` · ตรวจลายเซ็นของ LINE แล้วหาผู้ใช้จาก `line_binding` |
| Bounce / complaint ของอีเมล | ผู้ให้บริการ (SES ผ่าน SNS) เรียก `POST /hooks/email-feedback?token=…` (`EMAIL_FEEDBACK_TOKEN`) · bounce ถาวร / รายงานสแปม / bounce ชั่วคราว 5 วัน → `email_suppressions` แล้วแจ้งเตือนทางอีเมลถึงคนนั้นเป็น `suppressed` (O23) |
| Webhook ขาเข้า | ตรวจลายเซ็นของผู้ให้บริการแต่ละราย |

### รูปแบบข้อมูล

- JSON ใช้ `camelCase` · วันที่ในแผนเป็น `"2026-12-02"` · เวลาเป็น ISO 8601 พร้อม timezone
- Man-Day ส่งเป็นตัวเลข (`5`, `0.25`) · เงินส่งเป็นสตางค์ (`300000` = 3,000 บาท)
- คนในงานส่งเป็น `{ id, displayName, initials, avatarUrl }` · ถ้าผู้เรียกเป็น **Guest** ให้ตัดชื่อคนทิ้งตามคำตัดสินเรื่อง Guest

### รายการ (List)

```
GET .../issues?status=in_progress&assignee=me&module=<id>&sprint=current&limit=50&cursor=<opaque>
```

- แบ่งหน้าด้วย `cursor` (ไม่ใช้ offset เพราะตารางงานเปลี่ยนตลอด) · ตอบ `{ items, nextCursor }`
- เลือกฟิลด์ด้วย `fields=` เมื่อหน้าจอต้องการเฉพาะบางคอลัมน์ (Table, Timeline มีหลายร้อยแถว)

### แก้ข้อมูลพร้อมกัน

- `GET` งานหรือโปรเจกต์ตอบ `ETag: "<version>"`
- `PATCH` ต้องส่ง `If-Match: "<version>"` · ถ้าไม่ตรงตอบ `409 conflict` พร้อมค่าล่าสุดและรายชื่อฟิลด์ที่ชน เพื่อให้หน้าจอแสดง "Due ถูกเปลี่ยนโดย Mick ขณะที่คุณกำลังแก้" (M1 › REALTIME)
- `PATCH` ส่งเฉพาะฟิลด์ที่เปลี่ยน · ไม่ส่ง `If-Match` ตอบ `428`
- **รอบแรก (apps/api) ตอบ 409 ทุกครั้งที่ version ไม่ตรง** · การรวมฟิลด์ที่ไม่ชนกันให้อัตโนมัติต้องรู้ว่าแต่ละ version แก้ฟิลด์ไหน จะทำเมื่อมี Realtime

### Error

```json
{
  "error": {
    "code": "due_change_requires_approval",
    "message": "ต้องส่งคำขอเลื่อน Due ให้ PM อนุมัติ",
    "details": { "approvers": ["..."] },
    "requestId": "req_8f2a91"
  }
}
```

| HTTP | ใช้เมื่อ |
|---|---|
| 400 | ข้อมูลไม่ครบหรือผิดรูปแบบ · `details.fields` บอกช่องที่ผิด |
| 401 | ยังไม่ล็อกอิน หรือ Session หมดอายุ (M1 › SESSION) |
| 403 | ไม่มีสิทธิ์ · `details.requestAccess: true` เมื่อขอสิทธิ์ได้ (M1 › 403) |
| 404 | ไม่พบ · ถ้างานอยู่ในถังขยะตอบ `410 gone` พร้อม `deletedBy`, `deletedAt`, `restorableUntil` (M1 › 404) |
| 409 | ชนกับการแก้ของคนอื่น หรือขัดกติกา เช่น Key ซ้ำ |
| 402 | เกินสิทธิ์ของแพ็กเกจ · `details` บอกขีดจำกัด, ค่าปัจจุบัน และทางออก (Q2) · `plan_limit_reached` = เกินจำนวน · `plan_feature_unavailable` = แพ็กเกจไม่มีฟีเจอร์นี้ (`details.feature`) · ค่าทั้งหมดมาจากเวอร์ชันสิทธิ์ + ปรับเฉพาะราย ที่ทีม Friday ตั้ง (O21) |
| 422 | ขัดกฎ Workflow เช่น ย้ายไป Done ทั้งที่ Sub-task ยังไม่ครบ |
| 429 | เรียกถี่เกิน หรือใส่รหัสผ่านผิดเกินกำหนด · คำขอผ่าน API token เกิน "API ต่อนาที" ของแพ็กเกจตอบ `rate_limited` พร้อม `Retry-After` (ทุกคำตอบของ token มี `X-RateLimit-Limit` / `X-RateLimit-Remaining`) |

`requestId` แสดงในหน้า Error ให้ผู้ใช้คัดลอกส่งทีมช่วยเหลือ (M1 › ERROR)

### คำเตือนที่ไม่ใช่ Error

บางกติกาเตือนแต่ไม่บล็อก เช่น วันที่ Sub-task เกินช่วง Task แม่ หรือ Due ตรงวันหยุด · ตอบสำเร็จพร้อม `warnings: [{ code, message }]` ให้หน้าจอแสดงแถบเตือน (M1 › ERROR บันทึก)

### Realtime

WebSocket เดียวต่อแท็บ: `wss://.../realtime` แล้ว subscribe ตามช่อง

| ช่อง | ข้อมูล | หน้าจอ |
|---|---|---|
| `user:{id}` | `type: notification` = แจ้งเตือนใหม่ · `type: unread` = จำนวนเปลี่ยนจากการอ่าน / เสร็จ / เลื่อนเตือน (ไม่แสดง Toast) · ทั้งสองแบบมีจำนวนยังไม่อ่านแยกตาม Workspace | K4 กระดิ่ง, G |
| `project:{id}` | งานเปลี่ยน (id + version) ให้หน้าจอดึงใหม่เฉพาะแถวนั้น | 2–6, L1 |
| `issue:{id}` | ใครกำลังดู / กำลังพิมพ์, คอมเมนต์ใหม่ | C, D, M1 |
| `import:{jobId}` | ความคืบหน้าการนำเข้า | L3 |

ข้อความใน WebSocket เป็นแค่สัญญาณ ข้อมูลจริงดึงผ่าน REST เสมอ เพื่อให้ RLS และสิทธิ์ตรวจที่จุดเดียว

### งานเบื้องหลัง (BullMQ)

API ตอบทันทีแล้วส่งงานเข้าคิวสำหรับ: ส่งแจ้งเตือน (LINE, Email, Webhook), นำเข้า Excel, Export, คำนวณ Plan End ใหม่เมื่อวันหยุดเปลี่ยน, Automation, ประมวลผล Webhook ของ Git, รายงานประจำสัปดาห์, ล้างถังขยะ · endpoint ที่สร้างงานเบื้องหลังตอบ `202` พร้อม `jobId`

### Idempotency

`POST` ที่ทำซ้ำแล้วเสียหาย (ชำระเงิน, นำเข้า Excel, ส่งคำเชิญ, อนุมัติจาก LINE) รับ header `Idempotency-Key` · ส่งซ้ำด้วย Key เดิมภายใน 24 ชม. ได้ผลเดิม

---

## 2. หน้าจอ → API

ตัวพิมพ์ **หนา** = ข้อมูลหลักที่หน้านั้นโหลดตอนเปิด

### หน้าในโปรเจกต์

| หน้า | เปิดหน้า | การกระทำ |
|---|---|---|
| 1 · Overview | **`GET projects/{key}/overview`** (Progress, Health, KPI, Milestone, Workload สัปดาห์นี้, Burn-up, Activity ล่าสุด) | แก้ข้อมูลโปรเจกต์ `PATCH projects/{key}` |
| 2 · Table | **`GET projects/{key}/issues?view=table`** + `GET projects/{key}/saved-views` | Quick add `POST issues` · แก้ในแถว `PATCH issues/{key}` · เลือกหลายแถว `POST issues/bulk` · บันทึก View `POST saved-views` · Import / Export ดู L3 |
| 3 · Kanban | **`GET projects/{key}/board`** (คอลัมน์ของ Workflow มาตรฐาน + WIP + การ์ด · การ์ด Bug วางตาม `board_column_id` และส่งชื่อสถานะจริงมาด้วย · `?type=bug` ได้คอลัมน์ของ Workflow Bug) | ลากการ์ด `POST issues/{key}/move` · เพิ่มคอลัมน์ = เพิ่มสถานะ (L2) |
| 4 · Timeline | **`GET projects/{key}/timeline?from&to`** (Module › Task › Sub-task + Milestone + งานไม่มีวันที่) | ลาก bar `PATCH issues/{key}` (plan_start / plan_end) · `POST milestones` |
| 5 · Gantt | **`GET projects/{key}/gantt?from&to&baseline=v1`** (WBS, Dependency, Baseline, Critical path) | `POST issues/{key}/dependencies` · `POST projects/{key}/schedule:preview` (Auto-schedule) · `POST baselines` · `GET gantt.pdf` |
| 6 · Calendar | **`GET projects/{key}/calendar?month=2026-12`** (งาน, Sprint, วันหยุด, วันลา) | ลากวาง `PATCH issues/{key}` · `POST me/calendar-feeds` (iCal) |
| 7 · Members + Workload | **`GET projects/{key}/workload?from&to&unit=md`** + **`GET projects/{key}/members`** + `GET projects/{key}/invitations` | `PATCH members/{userId}` (Role, Capacity, `pmDeputy`) · `POST invitations` · Resend / Cancel |
| 8 · Files | **`GET projects/{key}/files?folder=`** + `GET projects/{key}/folders` | อัปโหลด `POST files:upload-url` → PUT S3 → `POST files` · `POST files/{id}/versions` · ผูกงาน `POST files/{id}/attachments` · Rename / Move / Delete |
| L1 · Backlog | **`GET projects/{key}/backlog`** (Sprint ทั้งหมด + Backlog + Burndown + capacity) | `POST sprints` · `POST sprints/{id}:start` · `POST sprints/{id}:complete` · ลากงาน `POST issues/{key}/move` (sprint + rank) |
| L2 · Project Settings | **`GET projects/{key}/settings`** (ทุกแท็บในครั้งเดียว) | แต่ละแท็บมี `PATCH`/`POST` ของตัวเอง (ดูหมวด 3.5) · Danger zone: `:archive`, `:transfer`, `DELETE` |
| L3 · Import Excel | `POST import-jobs` (อัปโหลด) → **`GET import-jobs/{id}`** (คอลัมน์, ตัวอย่าง, ผลตรวจ) | `PATCH import-jobs/{id}` (จับคู่คอลัมน์ / คน) · `POST import-jobs/{id}:commit` · แท็บการแก้ไขแผน `GET projects/{key}/plan-changes` |
| O1 · Lead Dashboard | **`GET projects/{key}/insights/risks`** + `GET projects/{key}/workload?group=week` + `GET projects/{key}/insights/modules` | — |
| O2 · Reports | **`GET projects/{key}/reports/weekly?week=`** + `GET .../reports/module-forecast` + `GET .../reports/traceability` | `POST reports/weekly:send` · `PUT report-schedule` |
| P2 · Automation | **`GET projects/{key}/automations`** + `GET automation-templates` | `POST`/`PATCH` · `POST automations/{id}:dry-run` · `GET automations/runs` |

### หน้างาน

| หน้า | เปิดหน้า | การกระทำ |
|---|---|---|
| B · สร้าง Task / Sub-task | `GET projects/{key}/form-options` (Module, Sprint, คน, Size map, Label, ประเภทงาน) | **`POST issues`** (สร้างพร้อม Sub-task, Checklist, Dependency, ไฟล์ได้ในครั้งเดียว) |
| K1 · สร้างตามประเภท | เหมือน B · ฟิลด์บังคับตาม `issue_type.required_fields` | `POST issues` |
| C · Task Detail | **`GET issues/{key}`** (รวม Sub-task, Checklist, Dependency, ไฟล์, Git) + `GET issues/{key}/activity` + `GET issues/{key}/comments` | `PATCH issues/{key}` · `POST comments` · Checklist CRUD · `POST :watch` · `POST time-logs` |
| D · Sub-task Detail | เหมือน C + `GET issues/{key}/test-runs` · สลับ Sub-task ← → ใช้ `siblings` ในคำตอบ | `POST test-runs` · `POST test-runs/{id}:create-bug` |
| K2 · Bug Detail | เหมือน C (มีฟิลด์ Bug) | `PATCH` · `POST issues/{key}:reopen` |
| K3 · ขอเลื่อน Due | `GET issues/{key}/due-requests:preview?due=` (ผลกระทบที่ระบบคำนวณ) | **`POST issues/{key}/due-requests`** |
| P3 · Dialog ยืนยัน | `GET .../delete-impact` ก่อนลบ (Sub-task, หลักฐาน, งานค้างของคน) | ลบแล้วแสดงปุ่ม "เลิกทำ" = `POST :restore` |

### หน้าส่วนตัวและทั้ง Workspace

| หน้า | เปิดหน้า | การกระทำ |
|---|---|---|
| E · Home | **`GET w/{ws}/home`** (สรุปวันนี้, รออนุมัติ / Review, โปรเจกต์ของฉัน, เปิดล่าสุด, 30 วันข้างหน้า, Workload) | ติ๊กปิดงาน `PATCH issues/{key}` |
| F · My Tasks | **`GET w/{ws}/my-issues?tab=assigned\|reviewer\|watching\|created&group=`** | ลากไปกลุ่ม "สัปดาห์หน้า" = `PATCH issues/{key}` (Due) หรือสร้างคำขอเลื่อน Due ตามสิทธิ์ |
| G · Inbox | **`GET me/notifications?workspace=&filter=`** | `POST notifications/{id}:read` · `:done` · `:snooze` · อนุมัติ / ปฏิเสธ `POST due-requests/{id}:approve` · `:reject` · Unwatch · ปิดประเภทนี้ `PUT me/notification-prefs` |
| K4 · กระดิ่ง | `GET me/notifications/summary` (ยังไม่อ่านแยก Workspace) + WebSocket `user:{id}` | — |
| P1 · ค้นหา | **`GET w/{ws}/search?q=&type=&project=`** · Command palette ใช้ `?q=&limit=8` | `POST saved-searches` |
| H · Workspace Members | **`GET w/{ws}/members`** + `GET w/{ws}/invitations` | `POST invitations` (หลายอีเมล) · `POST invite-links` · `PATCH members/{userId}` · `:deactivate` |
| I · Profile | **`GET me`** + `GET w/{ws}/me/membership` (ตำแหน่ง, Capacity, วันทำงาน) + `GET me/notification-prefs` + `GET me/sessions` | `PATCH me` · `PATCH me/membership` · `PUT me/notification-prefs` · `POST me/line/link-code` · `DELETE me/line` · `POST me/leaves` · `DELETE me/sessions/{id}` · 2FA ดูหมวด 3.1 |
| N1 · Admin Console | แยกตามแท็บ (หมวด 3.3) | |
| N2 · หน้าตาข้อความแจ้งเตือน | `GET w/{ws}/notification-templates/{event}:preview?channel=` | — |
| M1 · สถานะหน้าจอ | ใช้ธรรมเนียม Error / Realtime ด้านบน · ขอสิทธิ์ `POST projects/{key}/access-requests` | |

### ก่อนเข้า Workspace

| หน้า | API |
|---|---|
| J1 · Login + 2FA | `POST auth/login` → ถ้าต้องใช้ 2FA ได้ `mfaToken` → `POST auth/login/mfa` · `GET auth/oauth/{google\|microsoft}/start` · `POST auth/sso/discover` (จากโดเมนอีเมล) |
| J2 · Sign up | `POST auth/signup` → `POST auth/verify-email` (รหัส 6 หลักหรือลิงก์) · `POST auth/verify-email:resend` |
| J3 · ลืมรหัสผ่าน | `POST auth/password/forgot` (ตอบ 202 เสมอ ไม่บอกว่ามีบัญชีไหม) → `POST auth/password/reset` |
| J4 · รับคำเชิญ | `GET invitations/{token}` → `POST invitations/{token}:accept` หรือ `:decline` · ลิงก์หมดอายุ `POST invitations/{token}:request-new` |
| J5 · Onboarding | `GET workspaces/slug-available?slug=` · `POST workspaces` · `PATCH w/{ws}` (ทีม, วิธีทำงาน) · `POST w/{ws}/invitations` · เริ่มโปรเจกต์: `POST projects` / `POST import-jobs` / `POST projects:sample` |
| Q1 · สลับ Workspace | `GET me/workspaces` (Role, แพ็กเกจ, บังคับ SSO, จำนวนยังไม่อ่าน) · `POST workspaces` |
| A · New Project | `GET w/{ws}/project-templates` · `GET projects/key-available?key=` · **`POST w/{ws}/projects`** (ทุกขั้นของ Wizard ในครั้งเดียว) |

### SaaS

| หน้า | API |
|---|---|
| Q2 · เกินแพ็กเกจ | ไม่มี endpoint ของตัวเอง · ทุก endpoint ตอบ `402` ตามธรรมเนียม · แบนเนอร์ใช้ `GET w/{ws}/usage` |
| R1 · Landing + ราคา | `GET public/plans` (ไม่ต้องล็อกอิน) |
| R2 · ชำระเงิน | `GET w/{ws}/billing/quote?plan=&cycle=&wht=` (คำนวณ VAT / หัก ณ ที่จ่าย) · `PUT billing/profile` · **`POST w/{ws}/billing/checkout`** |
| R3 · ภาษา | `PATCH me` (locale, yearFormat) · `PATCH w/{ws}/settings` (ภาษาเริ่มต้น) |
| R4 · กฎหมาย + Cookie | `GET public/legal/{type}` · `POST me/legal-acceptances` · Cookie consent เก็บในเบราว์เซอร์ |
| Q3 · Super Admin | API แยกที่ `ops.friday.app` (หมวด 3.12) |
| Mobile (M2–M7) | ใช้ API เดียวกับหน้าเว็บ · M7 ย้ายการ์ดด้วยปุ่ม = `POST issues/{key}/move` |

---

## 3. รายการ Endpoint

Path ในตารางตัด `/api/v1` ออก · `w/` = `w/{workspace}/` · `p/` = `w/{workspace}/projects/{key}/` · `i/` = `w/{workspace}/issues/{issueKey}/`

คอลัมน์ "สิทธิ์" ใช้ชื่อสิทธิ์ที่จะกำหนดในขั้นที่ 4 · `member` = สมาชิก Workspace ที่ไม่ใช่ Guest · `self` = เจ้าของข้อมูล

คอลัมน์ "Event" คือเหตุการณ์ที่ส่งต่อให้ระบบแจ้งเตือน, Automation, Webhook และ Audit log

### 3.1 บัญชีและการล็อกอิน

| Method | Path | สิทธิ์ | Event / หมายเหตุ |
|---|---|---|---|
| POST | `auth/signup` | สาธารณะ | ส่งรหัสยืนยันอีเมล |
| POST | `auth/verify-email` · `:resend` | สาธารณะ | resend ได้ทุก 60 วินาที |
| POST | `auth/login` | สาธารณะ | นับครั้งผิดตาม `security_policy` ของ Workspace ที่เข้มที่สุดที่ผู้ใช้อยู่ · Audit `secu.login_failed` |
| POST | `auth/login/mfa` | มี `mfaToken` | รับ TOTP หรือ Backup code · `trustDevice` 30 วัน |
| GET | `auth/oauth/{provider}/start` · `/callback` | สาธารณะ | Google, Microsoft · ถ้าอีเมลตรงบัญชีเดิม ผูก `user_identity` เพิ่ม |
| POST | `auth/sso/discover` | สาธารณะ | ตอบว่าโดเมนนี้บังคับ SSO ไหม (ทำทีหลัง) |
| POST | `auth/logout` | self | |
| POST | `auth/password/forgot` · `auth/password/reset` | สาธารณะ | reset แล้วเลือกออกจากระบบทุกเครื่องได้ · ส่งอีเมลแจ้ง |
| GET / PATCH | `me` | self | ชื่อ, ภาษา, ปี พ.ศ./ค.ศ., timezone |
| POST | `me/email:change` | self | ยืนยันอีเมลใหม่ก่อนเปลี่ยน |
| POST | `me/password:change` | self | Audit `secu.password_changed` |
| GET / DELETE | `me/sessions` · `me/sessions/{id}` | self | |
| POST | `me/mfa:setup` → `me/mfa:enable` · `me/mfa:disable` · `me/mfa/backup-codes:regenerate` | self | ปิดไม่ได้ถ้า Workspace บังคับ 2FA |
| GET / DELETE | `me/identities` · `me/identities/{id}` | self | ลบวิธีสุดท้ายไม่ได้ |
| POST | `me/line/link-code` | self | รหัส 6 หลัก หมดอายุ 10 นาที · ผูกเสร็จเมื่อผู้ใช้ส่งรหัสในแชต OA (`/hooks/line`) แล้วแจ้งผ่าน WebSocket |
| DELETE | `me/line` | self | |
| POST | `me/line:test` | self | |
| GET | `me/workspaces` | self | |
| POST | `me/calendar-feeds` · DELETE `{id}` | self | ได้ URL iCal ที่มี token |
| POST | `me/legal-acceptances` | self | |

### 3.2 Workspace และสมาชิก

| Method | Path | สิทธิ์ | Event / หมายเหตุ |
|---|---|---|---|
| GET | `workspaces/slug-available` | ล็อกอินแล้ว | |
| POST | `workspaces` | ล็อกอินแล้ว | ผู้สร้างเป็น Owner · เริ่มทดลอง Team 14 วัน · เลือก `dataRegion` ได้เฉพาะค่าที่เปิดอยู่ |
| GET / PATCH | `w/` | ดู: สมาชิก · แก้: `ws.settings` | |
| GET | `w/usage` | สมาชิก | Seats, พื้นที่, ขีดจำกัดของแพ็กเกจ |
| GET | `w/members` | `member` (Guest ไม่เห็นรายชื่อคนในองค์กร) | |
| PATCH | `w/members/{userId}` | `ws.members.manage` | เปลี่ยน Role · Audit `perm.role_changed` · Owner คนสุดท้ายลดสิทธิ์ไม่ได้ |
| POST | `w/members/{userId}:deactivate` · `:reactivate` | `ws.members.manage` | ปิดแล้วยกเลิก Session, LINE binding และแสดงขั้นโอนงาน (P3) |
| GET / PATCH | `w/me/membership` | self | ตำแหน่ง, แผนก, Capacity, เวลาทำงาน |
| GET / POST | `w/invitations` | `ws.members.manage` หรือ `project.invite` (เชิญเข้าโปรเจกต์ตัวเอง) | สร้างได้หลายอีเมลในครั้งเดียว · ตรวจ Seat → `402` · Event `member.invited` |
| POST | `w/invitations/{id}:resend` · `:revoke` | ผู้ส่ง หรือ `ws.members.manage` | |
| GET | `invitations/{token}` | สาธารณะ | ข้อมูลเท่าที่จำเป็น: ชื่อ Workspace, ผู้เชิญ, Role, ข้อความ |
| POST | `invitations/{token}:accept` · `:decline` | ล็อกอินด้วยอีเมลที่ถูกเชิญ | Event `member.joined` แจ้งผู้เชิญและ PM |
| POST / DELETE | `w/invite-links` · `{id}` | `ws.members.manage` | |
| POST | `join/{linkToken}` | ล็อกอินแล้ว | |
| GET / POST | `w/access-requests` · `{id}:approve` · `:reject` | ขอ: ล็อกอินแล้ว · ตัดสิน: Admin | ใช้ทั้งขอเข้า Workspace (โดเมนเดียวกัน) และขอเข้าโปรเจกต์ |
| CRUD | `w/teams` · `w/teams/{id}/members` | `ws.settings` | |
| GET / POST / DELETE | `w/leaves` (`?user=`) | ของตัวเอง: self · ของคนอื่น: `ws.members.manage` | Event `leave.created` แจ้งคนที่มอบหมายงาน |
| GET | `w/workload?from&to&team=&basis=plan\|actual` | `ws.workload.view` | Workload รวมทุกโปรเจกต์ (N1) · `basis` ตามแผน / ตามจริง และ `compare` ต่อคน |

### 3.3 Admin Console (N1)

ทุก endpoint ในหมวดนี้ต้องเป็น Owner หรือ Admin ของ Workspace (`ws.settings`) ยกเว้นที่ระบุ · ทุกการแก้เขียน Audit log

| Method | Path | หมายเหตุ |
|---|---|---|
| GET | `w/admin/overview` | ผู้ใช้ active, งานทั้งหมด, เรื่องที่ต้องดำเนินการ |
| GET / PATCH | `w/settings` | เวลาทำงาน, Size → MD, อนุญาต override, Safe mode, ถังขยะ, การเก็บรักษา |
| GET / POST / DELETE | `w/holiday-calendars` · `w/holidays` | เปลี่ยนวันหยุดแล้วเข้าคิว `recalculate-plan-end` |
| CRUD | `w/project-templates` | |
| GET / PATCH | `w/security-policy` | |
| CRUD | `w/sso-connections` · `w/domains` · `w/domains/{id}:verify` | ทำทีหลัง |
| GET / PUT | `w/support-access` | เปิดสิทธิ์ทีม Friday · Audit |
| GET | `w/audit-log?category&user&from&to` · `w/audit-log.csv` | `ws.audit.view` |
| POST / GET | `w/exports` · `w/exports/{id}` | 202 + ลิงก์ดาวน์โหลดเมื่อเสร็จ |
| GET / PATCH | `w/data-requests` · `{id}:complete` | PDPA |
| DELETE | `w/` | Owner เท่านั้น · ต้องยกเลิกแพ็กเกจก่อน · กู้คืนได้ 30 วัน |
| GET / PUT | `w/channels/line-oa` · POST `:test` | เก็บ secret แบบเข้ารหัส · ตอบกลับเฉพาะ 4 ตัวท้าย |
| GET | `w/channels/line-groups` | กลุ่มที่เชิญ OA เข้าไป (มาจาก `/hooks/line`) |
| GET / PUT | `w/channels/email` · POST `:verify-dns` · `:test` | |
| CRUD | `w/channels/webhooks` · POST `{id}:test` | |
| GET | `w/channels/deliveries?status=failed` | ประวัติการส่งออกนอกแอป |
| GET / DELETE | `w/integrations/git` · `w/integrations/git/{id}/repositories` | ติดตั้ง GitHub App ผ่านหน้า GitHub แล้วกลับมาที่ `/hooks/github/setup` |
| CRUD | `w/api-tokens` | แสดง token เต็มครั้งเดียวตอนสร้าง |
| GET | `w/billing` | แพ็กเกจ, ใบแจ้งหนี้, วิธีชำระ (`ws.billing`) · ดูหมวด 3.10 |

### 3.4 โปรเจกต์

| Method | Path | สิทธิ์ | Event / หมายเหตุ |
|---|---|---|---|
| GET | `w/projects?status=` | สมาชิก (เห็นเฉพาะที่เข้าถึงได้) | Owner / Admin ได้โปรเจกต์ Private ที่ไม่ได้เป็นสมาชิกด้วย พร้อม `joined: false` |
| GET | `w/projects/key-available?key=` | `ws.project.create` | ตรวจทั้ง Key ปัจจุบันและ alias |
| POST | `w/projects` | `ws.project.create` | รับทุกขั้นของ Wizard (ดูตัวอย่างด้านล่าง) · ตรวจจำนวนโปรเจกต์ตามแพ็กเกจ → 402 |
| POST | `w/projects:sample` | `ws.project.create` | โปรเจกต์ตัวอย่างที่ใช้ข้อมูลสมมติ (ห้ามใช้ข้อมูลจริงของที่ทำงาน) |
| GET / PATCH | `p/` | ดู: `project.view` · แก้: `project.settings` | เปลี่ยน Key เพิ่ม alias อัตโนมัติ |
| GET | `p/overview` · `p/board` · `p/timeline` · `p/gantt` · `p/calendar` · `p/backlog` | `project.view` | Guest ได้เฉพาะ `overview` และ `timeline` แบบตัดชื่อคน · Timeline ของ Guest แสดงทั้งแผนยกเว้น Bug และบอก `canOpen` ว่างานไหนแชร์ให้เปิดได้ |
| GET | `p/workload` | `project.workload.view` | Guest ไม่ได้ · `?basis=plan\|actual` · `people[].compare` = ยอดตามแผนเทียบตามจริงในช่วง |
| GET | `p/form-options` | `issue.create` | |
| GET | `p/my-permissions` | `project.view` | ชุดสิทธิ์ของผู้เรียกในโปรเจกต์นี้ ใช้ซ่อนปุ่มในหน้าจอ |
| POST | `p/join-as-admin` | Workspace Owner / Admin | เข้าร่วมโปรเจกต์ Private เป็น Admin · Audit + แจ้ง Project Owner (ดู 04-permissions ข้อ 6) |
| POST | `p/:archive` · `:restore` | `project.settings` | |
| POST | `p/:transfer` | Project Owner | |
| DELETE | `p/` | Project Owner หรือ Workspace Admin · ต้องส่ง `confirmKey` | soft delete 30 วัน · Audit |
| GET | `p/delete-impact` | | จำนวนงาน, ไฟล์, สมาชิก สำหรับ Dialog |
| POST | `p/access-requests` | ล็อกอินแล้ว | |

**ตัวอย่าง `POST w/projects`** (ขั้นที่ 3–5 ของ Wizard ไม่บังคับ)

```json
{
  "name": "Development Plan 2026-11",
  "key": "DP",
  "clientName": null,
  "description": "ระบบสินเชื่อ Floor Plan ครบวงจร …",
  "templateId": "…",
  "color": "#334155",
  "startDate": "2026-10-01",
  "goliveDate": "2026-12-15",
  "timezone": "Asia/Bangkok",
  "holidayCalendarId": "…",
  "extraHolidays": [{ "date": "2026-12-31", "name": "Company outing" }],
  "sprintLengthWeeks": 2,
  "milestones": [{ "name": "Credit Line Go-live", "date": "2027-01-26" }],
  "scope": { "in": ["…"], "out": ["…"], "deliverables": ["…"], "acceptance": ["…"], "assumptions": [] },
  "modules": ["Credit Line", "Drawdown", "Pre-Disburse", "Repayment รับชำระเงิน"],
  "requirementFileIds": ["…"],
  "ownerUserId": "…",
  "visibility": "private",
  "members": [{ "userId": "…", "role": "member", "position": "backend", "capacityHoursWeek": 40 }],
  "invites": [{ "email": "…", "role": "member" }],
  "workflow": ["To do", "In progress", "Review", "Done"],
  "estimateUnit": "man_day",
  "progressMethod": "weighted",
  "budget": null
}
```

ตอบ `201` พร้อมโปรเจกต์และรายการที่สร้างให้ (จำนวน Module, Sprint, Milestone, คำเชิญ) ตามกล่อง "ระบบจะสร้างให้อัตโนมัติ"

### 3.5 ตั้งค่าโปรเจกต์ (L2)

ทุก endpoint ต้องมีสิทธิ์ `project.settings` ยกเว้นที่ระบุ

| Method | Path | หมายเหตุ |
|---|---|---|
| GET | `p/settings` | รวมทุกแท็บ |
| GET / POST / PATCH / DELETE | `p/members` · `p/members/{userId}` | เพิ่มคน: `project.invite` · ลบคนที่มีงานค้างต้องส่ง `reassignTo` (P3) |
| GET / PUT | `p/role-permissions` | ตาราง 10 รายการในหน้า L2 · Admin เปิดทุกอย่างเสมอ |
| CRUD + `:reorder` | `p/modules` · `p/modules/{id}/phases` | ลบ Module ที่มีงานต้องระบุ `moveTo` · เลือกกลุ่มงานปลายทางด้วย `moveToPhase` ได้ |
| CRUD | `p/milestones` · `p/milestones/{id}/issues` | |
| CRUD + `:reorder` | `p/workflows/{id}/statuses` | ลบสถานะที่มีงานต้องระบุ `moveTo` |
| CRUD | `p/workflows/{id}/rules` | |
| GET / PATCH | `p/issue-types/{id}` | เปิดปิด, ฟิลด์บังคับ |
| CRUD | `p/custom-fields` · `p/labels` | ฟิลด์มาตรฐานไม่อยู่ในรายการนี้ |
| CRUD | `p/repositories` | รูปแบบชื่อ branch, การย้ายสถานะอัตโนมัติ |
| GET / PUT | `p/notification-rules` · `p/notification-settings` | |
| POST | `p/holidays` · DELETE `{id}` | เข้าคิวคำนวณ Plan End ใหม่ |

### 3.6 Sprint, แผน และนำเข้า

| Method | Path | สิทธิ์ | Event / หมายเหตุ |
|---|---|---|---|
| POST / PATCH | `p/sprints` · `{id}` | `sprint.manage` | |
| POST | `p/sprints/{id}:start` | `sprint.manage` | มี Sprint active ได้ทีละ 1 · Event `sprint.started` |
| POST | `p/sprints/{id}:complete` | `sprint.manage` | body: `{ moveIncompleteTo: "<sprintId>" \| "backlog", retrospective }` · Event `sprint.completed` |
| GET | `p/baselines` · POST `p/baselines` | ดู: `project.view` · ตั้ง: `project.settings` | |
| GET | `p/plan-changes?baseline=` · `.xlsx` | `project.view` | Export ไฮไลต์จุดที่แก้ |
| POST | `p/schedule:preview` | `issue.edit` | Auto-schedule คืนรายการวันที่จะเปลี่ยนโดยยังไม่บันทึก · ยืนยันด้วย `POST issues/bulk` |
| POST | `w/import-jobs` | `ws.project.create` (ใหม่) หรือ `project.settings` (อัปเดต) | อัปโหลดไฟล์แล้วอ่านหัวคอลัมน์ · จับคู่อัตโนมัติ |
| GET / PATCH | `w/import-jobs/{id}` | ผู้สร้าง | แก้การจับคู่คอลัมน์และคน · ระบบตรวจซ้ำทุกครั้ง |
| POST | `w/import-jobs/{id}:commit` | ผู้สร้าง | 202 · ความคืบหน้าทาง WebSocket · ตั้ง Baseline v1 ถ้าเลือก · โหมดอัปเดตจับคู่ด้วย Key (ไฟล์รูปแบบเดิม: `excel_row_no`) และเขียน `plan_change` · Event `import.completed` · **รอบแรก (apps/api) ทำแบบ synchronous ตอบ 201** เพราะแผน 334 แถวใช้ไม่ถึง 1 วินาที · รองรับเฉพาะโหมดสร้างโปรเจกต์ใหม่ |
| GET | `p/export.xlsx` | `project.view` (ไม่ใช่ Guest) | ชีต Tasks (Key / Parent Key …) + Timeline + คำแนะนำ + ค่าที่ใช้ได้ + Holidays · `?timeline=week` = ชีต Timeline ช่องละสัปดาห์ · นำเข้ากลับโหมดอัปเดตได้ |
| GET | `w/import-template.xlsx` | สมาชิกที่ไม่ใช่ Guest | Template เปล่า คอลัมน์เดียวกับ Export · รายชื่อสมาชิกและวันหยุดของ Workspace |

### 3.7 งาน

| Method | Path | สิทธิ์ | Event / หมายเหตุ |
|---|---|---|---|
| GET | `p/issues` | `project.view` | ตัวกรองทั้งหมดของหน้า Table · `view=table` ส่งค่ารวมของ Module / กลุ่มงานมาด้วย |
| GET | `w/my-issues` | สมาชิก | ข้ามทุกโปรเจกต์ |
| POST | `p/issues` | `issue.create` | ดูรายละเอียดด้านล่าง · Event `issue.created` (+ `issue.assigned`) |
| GET | `i/` | `project.view` · Guest เฉพาะงานที่ `sharedWithGuests` | รวม Sub-task, siblings, Checklist, Dependency, ไฟล์, Git, คำขอเลื่อน Due ที่รออยู่ |
| PATCH | `i/` | `issue.edit` | ต้องมี `If-Match` · เลื่อน plan_end ออกไปโดยไม่มีสิทธิ์ `issue.change_due_directly` → `403 due_change_requires_approval` (ดู[กติกาการเปลี่ยน Due](#กติกาการเปลี่ยน-due)) · หลังมี Baseline ต้องส่ง `planChangeReason` · Event ตามฟิลด์ที่เปลี่ยน |
| POST | `i/move` | `issue.edit` | body: `{ statusId?, sprintId?, afterKey?, beforeKey?, confirm? }` ใช้ทั้ง Kanban, Backlog และ Mobile · `afterKey` = การ์ดเหนือจุดวาง · `beforeKey` = การ์ดใต้จุดวาง · `statusId` เป็นคอลัมน์ของบอร์ดมาตรฐานได้ ระบบเลือกสถานะของ Workflow งานนั้นที่ผูกกับคอลัมน์ (Bug: Review → Fixed) · ตรวจ WIP limit (เตือน) และกฎ Workflow (422 · ไป Done ทั้งที่ Sub-task ไม่ครบต้องส่ง `confirm: true`) · แก้ลำดับไม่เพิ่ม version · Event `issue.status_changed` |
| POST | `p/issues/bulk` | `issue.edit` / `issue.delete` | body: `{ keys[], set: { planEnd?, moduleId?, sprintId?, assigneeIds? } }` หรือ `{ keys[], delete: true, confirmText }` |
| DELETE | `i/` | `issue.delete` | ลบ Sub-task ตามไปด้วย · soft delete 30 วัน |
| POST | `i/:restore` | `issue.delete` | ใช้กับปุ่ม "เลิกทำ" และหน้า 404 |
| GET | `i/delete-impact` | | Sub-task, ไฟล์ที่เป็นหลักฐาน, Dependency |
| POST | `i/:reopen` | `issue.edit` | Bug: เพิ่ม `reopen_count` · Event `bug.reopened` |
| POST / DELETE | `i/:watch` | `project.view` | |
| PUT | `i/assignees` | `issue.edit` | Event `issue.assigned` |
| CRUD + `:reorder` | `i/checklist` | `issue.edit` | |
| GET / POST / DELETE | `i/dependencies` | `issue.edit` | ตรวจวนรอบ (A → B → A) → 409 |
| GET / POST / PATCH / DELETE | `i/comments` | ดู: `project.view` · เขียน: `issue.comment` · แก้ / ลบ: เจ้าของ | แยก @mention → Event `issue.mentioned` · Auto-watch ผู้เขียน |
| GET | `i/activity` | `project.view` | |
| GET / POST / DELETE | `i/time-logs` | `issue.edit` · เปิดเมื่อโปรเจกต์เปิด Time log เท่านั้น | |
| GET / POST | `i/test-runs` | บันทึก: `issue.record_test` | `kind` = qa (ผลตรวจ QA / Reviewer: result, `testerId` ผู้ตรวจ, environment, note, fileIds) หรือ unit (ผล Unit test: จำนวนเคส, coveragePct, commitSha) · ผล QA ไม่ผ่าน → Event `test_run.failed` |
| POST | `i/test-runs/{id}:create-bug` | `issue.create` | สร้าง Bug ใต้งานเดียวกัน กรอกขั้นตอน / หลักฐานจากผลทดสอบให้ |
| GET | `i/git` | `project.view` | Commit และ PR ที่ผูก |
| GET | `i/due-requests:preview?due=` | `issue.edit` หรือ `due_request.approve` | วันทำการที่เพิ่ม, Workload ของ Dev ในช่วงที่เลื่อนออก (เทียบ capacity), งานที่รออยู่, Milestone / Go-live ที่กระทบ, งานแม่, ผู้อนุมัติ |
| GET | `i/due-requests` · `w/due-requests?scope=to_approve\|mine&status=` | `project.view` (ไม่ใช่ Guest) | ประวัติของงาน · รายการรออนุมัติของฉัน (Home) |
| POST | `i/due-requests` | `issue.edit` และไม่มี `issue.change_due_directly` | ดูด้านล่าง · Event `due_request.created` ส่งเฉพาะผู้อนุมัติ |
| POST | `w/due-requests/{id}:approve` · `:reject` · `:cancel` | อนุมัติ: `due_request.approve` · ยกเลิก: ผู้ขอ | body: `{ note? }` · อนุมัติแล้วแก้ `plan_end` + เขียน `plan_change` · Due ถูกแก้หลังส่งคำขอ → `409 due_changed_since_request` · ตัดสินแล้ว → `409 already_decided` · Event `due_request.decided` |

**ตัวอย่าง `POST p/issues`** (หน้า B)

```json
{
  "typeId": "…",
  "parentKey": null,
  "moduleId": "…",
  "phaseId": "…",
  "sprintId": "…",
  "title": "Interface HP: ตั้งจ่าย",
  "description": "…",
  "statusId": "…",
  "assigneeIds": ["…", "…"],
  "baId": "…",
  "reviewerId": "…",
  "priority": "medium",
  "planStart": "2026-12-14",
  "size": "M",
  "estimateMd": 5,
  "requirements": ["FR-02.3"],
  "screens": ["SCR-203"],
  "labelIds": ["…"],
  "watcherIds": ["…"],
  "subtasks": [
    { "title": "Mapping ฟิลด์ HP → FP", "size": "XS", "assigneeIds": ["…"], "planEnd": "2026-12-14" }
  ],
  "checklist": [],
  "blockedBy": ["DP-38"],
  "fileIds": []
}
```

- `planEnd` ไม่ต้องส่งถ้ามี `estimateMd`: ระบบนับ Man-Day เป็นวันทำการจาก Plan Start (ข้ามวันหยุด · จำนวน Dev ไม่มีผล)
- `requirements` และ `screens` ส่งเป็นรหัส · ถ้ายังไม่มีในโปรเจกต์ ระบบสร้างให้
- ตอบ `warnings` เมื่อ Plan Start ตรงวันหยุด (เลื่อนให้แล้ว) หรือ Sub-task เกินช่วงงานแม่

**ตัวอย่าง `POST i/due-requests`** (หน้า K3)

```json
{
  "requestedDue": "2026-12-04",
  "reasonCode": "scope_added",
  "detail": "BA Donut ยืนยันเพิ่ม Plan Template แบบ Fleet (30 พ.ย.) ต้องใช้อีก 2 วันทำการ"
}
```

`reasonCode`: `scope_added` · `waiting_input` · `blocked_by_dependency` · `estimate_wrong` · `other` · ระบบเก็บผลจาก `:preview` ไว้ใน `impact` ณ เวลาที่ส่ง

#### กติกาการเปลี่ยน Due

สิทธิ์ `issue.change_due_directly` ตรงกับแถว **"เปลี่ยน Due โดยไม่ต้องขออนุมัติ"** ในหน้า L2 › สิทธิ์ของแต่ละ Role · ค่าเริ่มต้นเปิดเฉพาะ Admin · **PM เปิดให้ Member ได้รายโปรเจกต์**

| ผู้แก้ | สิทธิ์นี้ | ผล |
|---|---|---|
| Admin ของโปรเจกต์ | เปิดเสมอ | แก้ได้ทันที |
| Member | เปิด (PM ตั้งไว้) | แก้ได้ทันทีเหมือน Admin · หน้าจอไม่แสดงปุ่ม "ขอเลื่อน Due" |
| Member | ปิด (ค่าเริ่มต้น) | แก้ตรงไม่ได้ · หน้าจอเปิดฟอร์ม K3 แทน · อนุมัติแล้วระบบแก้ให้ |
| Viewer | — | แก้และขอไม่ได้ |

- ใช้กับทุกทางที่ทำให้ plan_end ของ Task หรือ Sub-task **เลื่อนออกไป**: แก้ในหน้างาน, แก้ในแถวของ Table, ลาก bar ใน Timeline / Gantt, ลากในปฏิทิน, ลากไปกลุ่ม "สัปดาห์หน้า" ใน My Tasks, แก้ Man-Day จน Plan End คำนวณใหม่, และ `POST issues/bulk`
- **ดึงเข้ามาให้เร็วขึ้น ไม่ต้องขออนุมัติ** (ตัดสิน 5 พ.ย. 2569)
- แก้ตรงหรืออนุมัติแล้ว ระบบเขียน `plan_change` ทุกครั้ง · หลังมี Baseline เหตุผลไม่บังคับ (ผู้ใช้ขอ 8 พ.ย. 2569: ไม่ต้องเตือน ให้ลง Activity ก็พอ) (แก้ตรง = ผู้แก้ใส่ · ผ่านคำขอ = ใช้เหตุผลในคำขอ)
- เปิดหรือปิดสิทธิ์นี้บันทึกใน Audit log · ปิดระหว่างที่มีคนแก้อยู่ ให้ยึดสิทธิ์ ณ เวลาที่ API ได้รับคำขอ
- ถ้ามีคำขอค้างอยู่ แล้ว PM เปิดสิทธิ์ให้ Member คำขอที่ค้างยังรออนุมัติตามเดิม ผู้ขอยกเลิกเองแล้วแก้ตรงได้

### 3.8 ไฟล์

| Method | Path | สิทธิ์ | หมายเหตุ |
|---|---|---|---|
| GET | `p/files?folder&uploader&sort` · `p/folders` | `project.view` | |
| POST | `p/files:upload-url` | `file.upload` | ได้ presigned URL ของ S3 · ตรวจขนาด ≤ 100 MB และพื้นที่ตามแพ็กเกจ → 402 |
| POST | `p/files` | `file.upload` | ยืนยันหลังอัปโหลดเสร็จ หรือแนบลิงก์ (Figma, Drive, Notion) |
| POST | `p/files/{id}/versions` | `file.upload` | |
| PATCH | `p/files/{id}` | `file.upload` | Rename, Move |
| DELETE | `p/files/{id}` | `file.delete` | ถ้าเป็นหลักฐานของผลทดสอบหรือ Bug ต้องส่ง `confirm: true` (P3) |
| GET | `p/files/{id}/download` | `project.view` | redirect ไป URL ที่หมดอายุใน 5 นาที |
| POST / DELETE | `p/files/{id}/attachments` | `file.upload` | ผูกกับงาน / ผลทดสอบ |
| CRUD | `p/folders` | `file.upload` | |
| GET | `p/trash` · POST `{type}/{id}:restore` | Admin | |

### 3.9 แจ้งเตือน, ค้นหา, รายงาน และ Automation

| Method | Path | สิทธิ์ | หมายเหตุ |
|---|---|---|---|
| GET | `me/notifications?workspace&filter&cursor` | self | กระดิ่งรวมทุก Workspace · Inbox กรองตาม Workspace |
| GET | `me/notifications/summary` | self | |
| POST | `me/notifications/{id}:read` · `:unread` · `:done` · `:snooze` · `me/notifications:read-all` | self | |
| GET / PUT | `me/notification-prefs` · `me/notification-settings` | self | ต่อ Workspace |
| GET | `w/notification-templates/{event}:preview` | Admin | N2 |
| GET | `w/search` | สมาชิก | ค้นชื่อ, รายละเอียด, คอมเมนต์, ข้อความในไฟล์ · กรองตามสิทธิ์ก่อนตอบ · `#DP-39` และ `@ชื่อ` |
| CRUD | `w/saved-searches` | self | |
| GET | `p/insights/risks` · `p/insights/modules` | `project.workload.view` | O1 |
| GET | `p/reports/weekly` · `module-forecast` · `traceability` | `project.view` (ไม่ใช่ Guest) | |
| POST | `p/reports/weekly:send` · GET / PUT `p/report-schedule` | Admin | |
| CRUD | `p/automations` | `project.settings` | |
| POST | `p/automations/{id}:dry-run` | `project.settings` | คืนรายการงานที่ตรงเงื่อนไขและสิ่งที่จะทำ โดยไม่บันทึก |
| GET | `p/automations/runs` | `project.settings` | |
| GET | `automation-templates` | ล็อกอินแล้ว | |
| CRUD | `p/saved-views` | ของตัวเอง: self · แชร์ทั้งโปรเจกต์: Admin | |

### 3.10 ชำระเงิน

| Method | Path | สิทธิ์ | หมายเหตุ |
|---|---|---|---|
| GET | `public/plans` | สาธารณะ | |
| GET | `w/billing` | `ws.billing` | |
| GET | `w/billing/quote?plan&cycle&wht` | `ws.billing` | subtotal, VAT 7%, หัก ณ ที่จ่าย 3%, ยอดชำระ · ใช้แสดงสรุปในหน้า R2 |
| GET / PUT | `w/billing/profile` | `ws.billing` | ข้อมูลใบกำกับภาษี |
| POST | `w/billing/checkout` | `ws.billing` | ต้องมี `Idempotency-Key` · บัตร: ได้ Stripe client secret · PromptPay: ได้ QR (หมดอายุ 15 นาที) · โอน: ได้ใบแจ้งหนี้ · หัก ณ ที่จ่ายเลือกได้เฉพาะ PromptPay / โอน |
| POST | `w/billing/invoices/{id}/slip` | `ws.billing` | แนบสลิป · สถานะ `pending_review` แต่ใช้แพ็กเกจใหม่ได้ทันที |
| POST | `w/billing/invoices/{id}/wht-certificate` | `ws.billing` | 50 ทวิ ภายใน 30 วัน |
| GET | `w/billing/invoices` · `{id}.pdf` · `w/billing/tax-documents/{id}.pdf` | `ws.billing` | |
| POST | `w/billing/subscription:cancel` | Owner | ใช้ต่อได้ถึงสิ้นรอบ |

### 3.11 Webhook ขาเข้า

| Path | จาก | ทำอะไร |
|---|---|---|
| `/hooks/github` · `/hooks/gitlab` | Git | ผูก Commit / PR กับงานจากชื่อ branch, message, title · ย้ายสถานะตามกฎของโปรเจกต์ · CI ล้มเหลว → แจ้ง Assignee |
| `/hooks/line` | LINE | ผูกบัญชีด้วยรหัส 6 หลัก · OA ถูกเชิญเข้า / ออกจากกลุ่ม · ปุ่มอนุมัติ / ปฏิเสธคำขอเลื่อน Due (ตรวจว่าบัญชี LINE ผูกกับผู้มีสิทธิ์อนุมัติ + Audit) |
| `/hooks/stripe` | Stripe | ชำระสำเร็จ / ล้มเหลว (บัตร, PromptPay) → อัปเดต invoice, subscription, ขอ e-Tax |
| `/hooks/etax` | ผู้ให้บริการ e-Tax | สถานะการออกเอกสาร |
| `/hooks/hr` | ระบบ HR | วันลาที่อนุมัติแล้ว → `leave` (source = hr) |

### 3.12 หลังบ้านทีม Friday (`ops.friday.app`)

แยกแอป, แยกโดเมน, ล็อกอินด้วย Security key · ไม่ใช้ RLS ของลูกค้า แต่ทุกคำขอเขียน `audit_log` ของ Workspace ที่ถูกแตะ

| Method | Path | หมายเหตุ |
|---|---|---|
| GET | `ops/metrics` | MRR, จ่ายเงิน, ทดลอง, ยกเลิก |
| GET | `ops/workspaces?plan&status` · `{id}` | |
| POST | `ops/workspaces/{id}/support-sessions` | ต้องมี grant จากลูกค้า, เลข Ticket, เหตุผล · โหมดแก้ไขต้องมีผู้อนุมัติคนที่ 2 · แจ้งลูกค้าทางอีเมลทันที |
| POST | `ops/support-sessions/{id}:end` | |
| POST | `ops/workspaces/{id}:extend-trial` · `:discount` · `:change-plan` · `:suspend` | |
| GET / POST | `ops/payments?status=pending_review` · `{id}:confirm` · `:reject` | ตรวจสลิปและ 50 ทวิ |
| CRUD | `ops/feature-flags` · `ops/announcements` | |

### 3.13 Endpoint ที่โค้ดมีเพิ่ม (รวมจากบันทึกผล · D99 · 8 พ.ย. 2569)

เทียบ `apps/api/openapi.json` (สร้างจากโค้ด มี test คุมว่าตรงกับ controller) กับตารางด้านบน · รายการนี้คือ path ที่ตารางยังไม่เขียนไว้ตรง ๆ · request / response ดูที่ `GET /api/v1/docs` (เปิดเฉพาะนอก production)

| Method | Path | หมายเหตุ |
|---|---|---|
| GET | `auth/csrf` | ออก CSRF token (cookie `fm_csrf`) ก่อนคำขอที่แก้ข้อมูล |
| GET | `auth/oauth/{provider}/callback` | ปลายทางของ Google / Microsoft (A13) · error หรือ `#mfaToken` ส่งกลับหน้า `/login` |
| POST | `me/email:confirm` | ยืนยันอีเมลใหม่ด้วยรหัส 6 หลัก / ลิงก์ |
| GET | `me/mfa` | สถานะ 2FA ของฉัน |
| POST | `me/notifications/{id}:undone` | ย้อนสถานะ "เสร็จ" ของรายการใน Inbox |
| GET | `ical/{file}` | ไฟล์ iCal สาธารณะ · ความลับอยู่ที่ token ในชื่อไฟล์ · ลบลิงก์ด้วย `DELETE me/calendar-feeds/{id}` |
| GET | `public/legal` · `public/legal/{type}` | เอกสารกฎหมายรุ่นปัจจุบัน (A30 · หน้า Legal) |
| PUT / GET | `storage/upload/{token}` · `storage/download/{token}` | ที่เก็บไฟล์ในเครื่องสำหรับพัฒนา · production ตั้ง `S3_BUCKET` แล้วใช้ presigned URL ของ S3 แทน |
| GET | `/api/v1/docs` · `/api/v1/openapi.json` | Swagger UI / OpenAPI (A40) · 404 ใน production |
| POST | `/api/v1/workspaces` | สร้าง Workspace (Q1) |
| GET | `workspaces/deleted` | Workspace ที่ฉันลบและยังกู้คืนได้ (คู่กับ `workspaces/{slug}:restore`) |
| POST | `w/access-requests/{id}:reject` | คู่กับ `:approve` |
| GET | `w/members/{userId}/handover` | งานที่ต้องโอนก่อนปิดบัญชีสมาชิก (N1) |
| GET | `w/home` | ข้อมูลหน้า Home ทั้งหน้าในคำขอเดียว (A10) |
| GET | `w/automation-templates` | แม่แบบ Automation · Guest ไม่ได้ |
| DELETE | `w/holiday-calendars/{id}` · `w/holidays/{id}` | Admin Console › วันหยุด |
| GET | `w/integrations/git/install-url` · POST `w/integrations/git/{id}/sync` · DELETE `w/integrations/git/{id}` | ติดตั้ง GitHub App, ดึงข้อมูลซ้ำ, เลิกเชื่อม (A27) |
| POST · DELETE | `w/leaves/{id}:approve` · `w/leaves/{id}` | อนุมัติ / ลบวันลา (A20) |
| PATCH · GET | `w/data-requests/{id}` · `w/data-requests/{id}/result` | คำขอ PDPA: แก้สถานะ / ดาวน์โหลดผล (A31) |
| GET | `w/exports/{id}/download` | ไฟล์ Export ทั้ง Workspace |
| GET | `w/billing/invoices/{file}` · `w/billing/tax-documents/{file}` | PDF ใบแจ้งหนี้ / ใบกำกับภาษี (A33) |
| GET | `p/issue-types` · `p/workflows` | รายการสำหรับหน้า Settings (L2) |
| GET | `p/plan-changes.xlsx` | Export การแก้แผนพร้อมไฮไลต์ |
| GET | `p/reports/module-forecast` · `p/reports/traceability` | คาดการณ์วันจบราย Module · ตาราง FR / Screen → งาน (A09) |
| POST | `p/files/{id}:restore` | กู้ไฟล์จากถังขยะ |
| GET | `i/watchers` | รายชื่อผู้ติดตาม (คู่กับ `i/:watch`) |
| PATCH · DELETE | `i/comments/{id}` · DELETE `i/time-logs/{id}` | แก้ / ลบรายการของตัวเอง |
| POST | `hooks/line/{workspaceId}` | LINE OA ของแต่ละ Workspace (ตาราง 3.11 เขียนเป็น `/hooks/line`) |

ทุก `:action` ในโค้ดรับทั้ง `/action` และ `\:action` (ดูธรรมเนียม URL ข้างบน) · Webhook ขาเข้าอยู่ใต้ `/api/v1/hooks/...` ไม่ใช่ `/hooks/...`

#### ฟิลด์ของงานที่เพิ่มหลังร่างแรก

- `requirements`, `screens` (รหัส), `labels` (`{ id, name, color }`) อยู่ในทุก DTO ของงาน · `PATCH i/` รับ `requirements`, `screens`, `labelIds` แบบแทนทั้งชุด · ตัวกรอง `q` ของ `p/issues` ค้นรหัส FR / SCR ด้วย · `p/form-options` คืน `requirements` และ `screens` ที่มีในโปรเจกต์
- `DELETE i/?subtasks=keep` เก็บ Sub-task ไว้เป็น Task เดี่ยว (หน้า P3)

---

## Event ที่ระบบส่งต่อ

ใช้ร่วมกันโดยระบบแจ้งเตือน (ส่งหาใคร), Automation (trigger), Webhook ของโปรเจกต์ (เข้ากลุ่ม) และ Audit log

| Event | เกิดเมื่อ | ส่งหาใครโดยค่าเริ่มต้น |
|---|---|---|
| `issue.created` | สร้างงาน | — (Automation, Webhook) |
| `issue.assigned` | ได้รับมอบหมาย / เปลี่ยนผู้รับผิดชอบ | Assignee ใหม่ |
| `issue.status_changed` | ย้ายสถานะ | Watcher, เจ้าของ Task แม่ (เมื่อ Sub-task เปลี่ยน) |
| `issue.review_requested` | ย้ายเข้าสถานะ Review | Reviewer |
| `issue.updated` | แก้ฟิลด์อื่น | Watcher |
| `issue.commented` · `issue.mentioned` | คอมเมนต์ / ถูก @mention | Watcher · คนที่ถูก mention |
| `issue.due_soon` · `issue.overdue` | Job ตามเวลา | Assignee (ตามค่าใน Profile) · Overdue ส่ง PM ด้วย |
| `due_request.created` · `due_request.decided` | ขอเลื่อน / อนุมัติหรือปฏิเสธ | ผู้อนุมัติ · ผู้ขอ |
| `bug.created` · `bug.reopened` | | Assignee, BA · Critical ส่งทันทีแม้อยู่ในช่วงงดส่ง |
| `test_run.failed` | ผลทดสอบไม่ผ่าน | Assignee |
| `sprint.started` · `sprint.completed` | | สมาชิกโปรเจกต์ |
| `plan.changed` | แก้แผนหลังมี Baseline | PM |
| `project.health_changed` | Health เปลี่ยนระดับ | PM |
| `member.invited` · `member.joined` | | ผู้เชิญ, PM |
| `import.completed` | นำเข้าเสร็จ | ผู้นำเข้า |
| `report.weekly` | ตามรอบที่ตั้ง | ตาม `report_schedule` |

ผู้ที่ทำ action เองไม่ได้รับแจ้ง · ทุกข้อความที่ส่งออกนอกแอปเขียน `notification_delivery` · Safe mode ส่งแค่หัวข้อ + ลิงก์
