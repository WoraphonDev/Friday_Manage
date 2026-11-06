# A18 · Admin Console ของ Workspace

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | T00, A05 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/admin/**` · `apps/api/test/admin.e2e.test.ts` |
| หน้าจอ | N1 (`design/canvas/AdminConsole.dc.html`) |
| สเปก | 03-api › 3.3 (แถวที่ไม่ได้ระบุว่าเป็นของงานอื่น) · 03-api › 3.2 แถว `w/teams` |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `GET w/admin/overview` · `GET / PATCH w/settings` · `GET / POST / DELETE w/holiday-calendars`, `w/holidays` (เปลี่ยนแล้วเรียก `recalculatePlanEnds` ของ A05 ทุกโปรเจกต์ที่ใช้ปฏิทินนั้น)
- `CRUD w/project-templates` · `GET / PATCH w/security-policy` · `CRUD w/teams`, `w/teams/{id}/members`
- `GET w/audit-log?category&user&from&to` และ `.csv` (`ws.audit.view`)

## กติกาที่ต้องตรง

- ทุกการแก้เขียน Audit log

## เสร็จเมื่อ

- [x] test ครอบคลุมทุกข้อ
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- ช่องทางแจ้งเตือน (A24, A25)
- Git (A27)
- API token (A28)
- Billing (A29)
- Export / PDPA / support access (A31)

## บันทึกผล

### Endpoint (`apps/api/src/admin/`) · Owner / Admin ทุกข้อ (Member → 403 `forbidden`, audit-log ระบุ `ws.audit.view`)

| Method | Path | หมายเหตุ |
|---|---|---|
| GET | `w/:ws/admin/overview` | `users {active, seatLimit, guests, activeLast7Days}`, `projects {active, archived, limit}`, `storage`, `issues {total, open}`, `weeklyActiveUsers[8 สัปดาห์]`, `mfa {enabled,total}`, `actions[]` (`access_requests_pending`, `mfa_missing`, `over_capacity`, `seats_near_limit`, `trial_ending`), `projectList[]` (PM, จำนวนสมาชิก, กิจกรรมล่าสุด; รวมที่ Archive) |
| GET / PATCH | `w/:ws/settings` | เวลาทำงาน, วันทำงาน (ISO 1–7), Size → MD, `allowProjectOverride`, `safeMode`, `trashDays` (30/90), `archiveRetentionYears` (null = เก็บถาวร), `requireConsentOnFirstLogin`, `holidayCalendarId` · PATCH คืน `recalculated {projects, issues}` |
| GET / PATCH | `w/:ws/security-policy` | รหัสผ่าน, ล็อกบัญชี, Session, `mfaEnforcement`, โดเมนอีเมลที่สมัครได้, IP Allowlist · GET คืน `mfa {enabled,total,missing[]}` ด้วย |
| GET / POST / DELETE | `w/:ws/holiday-calendars` (`:id`) | POST `{name, copyFromId?}` คัดลอกจากปฏิทิน ธปท. ของระบบเป็นของ Workspace · DELETE ไม่ได้ถ้าเป็นค่าเริ่มต้นหรือโปรเจกต์ใช้อยู่ (409 `calendar_in_use`) |
| GET / POST / DELETE | `w/:ws/holidays` (`:id`) | GET `?calendarId&year&from&to` · POST `{calendarId?, date, name, kind}` · ปฏิทินของระบบแก้ไม่ได้ (409 `calendar_readonly`) · เพิ่ม/ลบแล้วเรียก `recalculatePlanEnds` ทุกโปรเจกต์ที่ใช้ปฏิทินนั้น คืน `recalculated` |
| GET / GET:id / POST / PATCH / DELETE | `w/:ws/project-templates` | `config` ตรวจด้วย `TemplateConfig` ชุดเดียวกับ `POST w/projects` · `usageCount` เพิ่มเมื่อสร้างโปรเจกต์ (A04) · ลบแล้วโปรเจกต์ที่สร้างไปแล้วไม่กระทบ |
| GET / GET:id / POST / PATCH / DELETE | `w/:ws/teams` | คืน `lead`, `memberCount`, `capacityMdWeek` (ชั่วโมง ÷ 8), `projectCount` |
| POST / DELETE | `w/:ws/teams/:id/members` · `.../members/:userId` | POST `{userIds[]}` · สมาชิก active ที่ไม่ใช่ Guest เท่านั้น · หัวหน้าที่ออกจากทีม = ไม่มีหัวหน้า |
| GET | `w/:ws/audit-log?category&user&action&from&to&limit&before` | ใหม่ก่อน · `nextCursor` = เวลา (ISO) ของรายการสุดท้าย → ส่งเป็น `before` · `from`/`to` เป็นวันที่เวลาไทยครอบทั้งวัน |
| GET | `w/:ws/audit-log.csv` | ตัวกรองเดียวกัน (ไม่แบ่งหน้า ≤ 50,000 แถว) · UTF-8 BOM · กัน CSV injection (เซลล์ที่ขึ้นต้น `= + - @` ใส่ `'` นำหน้า) · การ export เขียน Audit `audit_log.exported` |

ทุกการแก้เขียน Audit log (`workspace.settings_updated`, `security_policy.updated`, `calendar.*`, `holiday.*`, `template.*`, `team.*`) ตามหมวด perm / data / secu / plan / notify · ไม่มีการเปลี่ยนแปลง = ไม่เขียนซ้ำ

### คำตัดสินที่เลือกเอง

- **คำนวณ Plan End ทำในธุรกรรมเดียวกับการแก้** (เรียก `recalculatePlanEnds` ตรง ๆ) แทนเข้าคิว `recalculate-plan-end` ตาม 03-api เพราะผลต้องตรงทันทีที่ตอบ และ A05 ออกแบบฟังก์ชันให้เรียกในธุรกรรม · ถ้าโปรเจกต์ใหญ่มากค่อยย้ายไปคิว (`Jobs`) โดยใช้ `CalendarsService.snapshot()` / `recalculate()` เดิม
- **เปลี่ยนวันทำงาน (workDays) ก็คำนวณแผนใหม่ด้วย** เพราะกระทบวันทำการของทุกงาน (ไฟล์งานพูดถึงเฉพาะปฏิทินวันหยุด) · เปลี่ยนเวลาทำงานไม่กระทบแผน
- ปฏิทินที่ระบบสร้าง (ธปท.) แก้ไม่ได้ → ให้ `POST holiday-calendars {copyFromId}` แล้วตั้งเป็นค่าเริ่มต้น (หน้า N1 "นำเข้าจากประกาศ ธปท.")
- **IP Allowlist กันล็อกตัวเอง**: ถ้า IP ของผู้แก้ไม่อยู่ในรายการ → 422 `ip_allowlist_locks_you_out` · **ฝั่ง Auth ยังไม่บังคับ IP Allowlist / โดเมนอีเมล / `mfaEnforcement` / `passwordRotationDays`** (เก็บค่าไว้เท่านั้น ดู "คำขอนอก lane")
- `mfa` นับจาก `mfa_factors` ผ่าน `SYSTEM_DB` (RLS ให้อ่านเฉพาะแถวตัวเอง) โดยจำกัดที่สมาชิก active ของ Workspace นี้เท่านั้น
- `over_capacity` = ผลรวมชั่วโมงที่แบ่งให้โปรเจกต์ (`project_members.capacity_hours_week`) เกิน `workspace_members.capacity_hours_week`
- ทีม: Capacity = Σ ชั่วโมงต่อสัปดาห์ ÷ 8 (1 MD = 8 ชม. ตามธรรมเนียมใน `docs/decisions.md`)

### ไม่ได้ทำ (ตามไฟล์งาน / ทำทีหลัง)

- `w/sso-connections`, `w/domains` (3-api ระบุ "ทำทีหลัง") · `w/support-access`, `w/exports`, `w/data-requests` (A31) · `DELETE w/` (ลบ Workspace) · ช่องทางแจ้งเตือน/Git/API token/Billing (A24–A29 มีแล้วใน lane ตัวเอง)

### คำขอนอก lane

- **A-Auth (ผู้ดูแล `apps/api/src/auth/**`)**: ให้ `AuthGuard`/login ใช้ `security_policies.ip_allowlist`, `allowed_email_domains` (ตอน signup / รับคำเชิญ), `mfa_enforcement`, `password_rotation_days` และ `session_idle_hours` · ฟังก์ชัน `ipAllowed(rules, ip)` ใน `admin/admin.service.ts` ใช้ได้เลย (รองรับ IPv4/IPv6/CIDR)
- **A04 (projects)**: `workspace_settings.allow_project_override = false` ยังไม่มีผลกับ Project Settings (ไม่ให้โปรเจกต์ตั้งเวลา/Size → MD เอง) · `trash_days` / `archive_retention_years` ยังไม่มี job ลบถาวร (A31 / purge job)
- **W (หน้า N1)**: ใช้ endpoint ข้างบน · ตัวเลขใน Canvas มาจาก `admin/overview` + `security-policy.mfa`
- **D99**: เพิ่ม `GET w/admin/overview` response, `holiday-calendars POST copyFromId`, `teams/{id}/members DELETE`, `audit-log` query/`nextCursor` ใน 03-api 3.3

### ผล test

`apps/api/test/admin.e2e.test.ts` 17 ข้อ: สิทธิ์ทุก endpoint (Owner/Admin ได้ · Member/คนนอก ไม่ได้) · overview (ผู้ใช้, Guest, โปรเจกต์, งาน, 2FA, คำขอเข้าร่วม) · settings (ตรวจข้อมูลทุกฟิลด์, Audit, ไม่เขียนซ้ำเมื่อไม่เปลี่ยน, เปลี่ยนวันทำงานคำนวณ Plan End + plan_change เหตุผล "วันหยุดเปลี่ยน") · ปฏิทิน (ของระบบแก้ไม่ได้, คัดลอก, ตั้งค่าเริ่มต้น, เพิ่ม/ลบวันหยุดแล้วแผนเปลี่ยนตาม, เปลี่ยนปฏิทินเริ่มต้น, ลบปฏิทินที่ใช้อยู่ไม่ได้) · Template CRUD + นับการใช้ · security-policy (ค่าเริ่มต้น, ตรวจข้อมูล, IP Allowlist กันล็อกตัวเอง + CIDR) · ทีม (สร้าง/แก้/สมาชิก/ลบ, Guest ไม่ได้) · Audit log (กรอง, แบ่งหน้า, CSV + BOM + กัน injection, รอย export) · `pnpm typecheck` ผ่าน · API 478 ผ่าน (ข้าม 6 = เดิม)
