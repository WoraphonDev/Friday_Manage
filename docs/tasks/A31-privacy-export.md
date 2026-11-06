# A31 · PDPA, Export ข้อมูล Workspace, สิทธิ์ทีม Friday, ลบ Workspace

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | T00, A16, A29 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/privacy/**` · `apps/api/test/privacy.e2e.test.ts` |
| หน้าจอ | N1 (`design/canvas/AdminConsole.dc.html`) |
| สเปก | 03-api › 3.3 แถว exports, data-requests, support-access, `DELETE w/` |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `POST / GET w/exports` (202 → คิว → ไฟล์ zip JSON / CSV)
- `GET / PATCH w/data-requests` · `{id}:complete`
- `GET / PUT w/support-access` + Audit
- `DELETE w/` (Owner, ต้องยกเลิกแพ็กเกจก่อน, กู้คืนได้ 30 วัน)

## เสร็จเมื่อ

- [x] test ครอบคลุมทุกข้อ
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

### Endpoint (`apps/api/src/privacy/`) · Owner / Admin ยกเว้นที่ระบุ (Member → 403)

| Method | Path | หมายเหตุ |
|---|---|---|
| POST | `w/:ws/exports` | **202** `{id, status, requestedBy, expiresAt, downloadUrl}` · ส่งเข้าคิว `privacy.export` หลัง commit · ครั้งละหนึ่งงาน (409 `export_in_progress`) |
| GET | `w/:ws/exports` · `w/:ws/exports/:id` | `status`: `queued · running · ready · failed · expired` · `downloadUrl` มีเมื่อ `ready` และยังไม่หมดอายุ |
| GET | `w/:ws/exports/:id/download` | สตรีม zip (ต้องล็อกอินเป็น Owner/Admin) · 409 `export_not_ready` · 410 `export_expired` (ใช้ได้ 7 วัน แล้วงาน `privacy.cleanup-exports` ลบไฟล์) · Audit `export.downloaded` |
| GET / POST | `w/:ws/data-requests` | GET `?status=pending\|in_progress\|completed\|rejected\|open\|all` · POST `{requesterEmail, requestType: erase\|export}` บันทึกคำขอที่ได้รับ (ครบกำหนด +30 วัน, ซ้ำ → 409) · คืน `daysLeft`, `overdue` |
| PATCH | `w/:ws/data-requests/:id` | `{status: pending\|in_progress\|rejected}` · ปิดแล้วแก้ไม่ได้ (409) |
| POST | `w/:ws/data-requests/:id/complete` (และ `:id\:complete`) | `export` → สร้างสำเนาข้อมูลของผู้ขอ · `erase` → ต้องส่ง `confirmEmail` = อีเมลผู้ขอ · คืน `result` |
| GET | `w/:ws/data-requests/:id/result` | ดาวน์โหลด JSON สำเนาข้อมูล (เฉพาะ `export` ที่ปิดแล้ว) |
| GET / PUT | `w/:ws/support-access` | GET: Owner/Admin `{enabled, expired, until, maxMode, notifyAdmins, grantedBy, sessions[≤20]}` · PUT: **Owner เท่านั้น** (`ws.owner`, RLS บังคับซ้ำ) `{enabled, duration: forever\|7d\|30d, maxMode: read\|write, notifyAdmins}` · Audit `support_access.granted/updated/revoked` |
| DELETE | `w/:ws` | **Owner** · body `{confirmSlug}` · 409 `subscription_active` ถ้าแพ็กเกจเป็น `active` / `past_due` (ต้องยกเลิกก่อน; `trialing` / `canceled` ลบได้) · คืน `{deletedAt, restorableUntil}` |
| GET | `workspaces/deleted` | Workspace ที่ฉันเป็น Owner และยังกู้คืนได้ |
| POST | `workspaces/:slug/restore` (และ `:slug\:restore`) | กู้คืน (Owner) · เกิน 30 วัน → 410 `restore_expired` |

### เนื้อหา Export (zip)

`workspace.json` (Workspace, ตั้งค่า, นโยบายความปลอดภัย, สมาชิก, ทีม, ปฏิทินวันหยุด, Template) · `members.csv` · `projects/<KEY>/project.json` (โครงสร้าง, Sprint, Milestone, Label, สมาชิก, Workflow, Baseline, plan_changes) · `issues.json` (งาน + ผู้รับผิดชอบ + Label + **คอมเมนต์** + **ประวัติ**) · `issues.csv` (UTF-8 BOM, กัน CSV injection) · `dependencies.json` · `files-manifest.json` + ไฟล์แนบเวอร์ชันล่าสุดใต้ `projects/<KEY>/files/` (≤ 25 MB ต่อไฟล์, ≤ 200 MB รวม · เกินจากนี้อยู่ใน manifest ให้ดาวน์โหลดแยก) · **ไม่รวมความลับ**: รหัสผ่าน, token, secret ของช่องทาง/Webhook, API token · สร้างภายใต้ RLS ของผู้ขอ (Owner/Admin เห็นทุกโปรเจกต์รวม Private)

### คำตัดสินที่เลือกเอง

- **คำขอ PDPA ต้องมีทางเข้า**: 03-api มีแค่ `GET/PATCH` + `:complete` จึงเพิ่ม `POST w/data-requests` ให้ Admin บันทึกคำขอที่ได้รับทางอีเมล/ฟอร์ม (ยังไม่มีฟอร์มสาธารณะ — ถ้าจะมีให้ต่อที่ `src/public/**`)
- **ขอลบข้อมูล (erase)** ทำในขอบเขตของ Workspace นี้: ถอนจากทีม / โปรเจกต์ / Watcher / แจ้งเตือน, ตั้งสมาชิกเป็น `deactivated` · ถ้าผู้ขอไม่มี Workspace อื่นที่ยังใช้งาน → ทำบัญชีเป็นนิรนาม (`erased-<id>@invalid.example`, ชื่อ "ผู้ใช้ที่ถูกลบ", ล้างรหัสผ่าน / Session / MFA / identity) ผ่าน `SYSTEM_DB` เพราะ `users` เป็นของทั้งระบบ · **งาน คอมเมนต์ และประวัติที่เขาเขียนคงอยู่** (เป็นบันทึกทางธุรกิจ) แต่ชื่อผู้เขียนกลายเป็นนิรนามเพราะอ้างผ่านบัญชี · Owner คนเดียวลบไม่ได้ (409 `last_owner`)
- สำเนาข้อมูล (export) เก็บเป็นไฟล์ JSON ในที่เก็บ (`uploads/privacy/<id>.json`) ไม่ผูก `files` เพราะตารางนั้นผูกโปรเจกต์ → `result_file_id` ว่าง
- **ลบ Workspace ใช้ `SYSTEM_DB`เขียน `deleted_at`** เพราะนโยบาย RLS ซ่อนแถวที่ลบแล้ว (WITH CHECK ไม่ผ่านถ้าเขียนด้วยแอป) · ตรวจ Owner + slug + แพ็กเกจก่อนเสมอ · หลังลบ `w/:ws` ตอบ 404 ทั้ง Workspace (สมาชิกทุกคน)
- ลบถาวรหลัง 30 วันด้วยงาน `privacy.purge-workspaces` (ทุกวัน 04:00): `DELETE workspaces` ให้ FK cascade ลบข้อมูลทั้งหมด + ลบไฟล์ในที่เก็บเครื่อง (S3 ยังไม่ลบ — ดู "คำขอนอก lane")
- Export อนุญาต Owner และ Admin (ไม่ใช่ Owner อย่างเดียว) เพราะ 03-api ระบุ `ws.settings` ทั้งหมวด · ถ้าต้องการเข้มกว่านี้ให้เปลี่ยน `assertAdmin` เป็น `assertOwner` ใน `exports.service.ts`

### คำขอนอก lane

- **A11 (files)**: เพิ่มเมธอดลบ object ใน `StorageDriver` (ตอนนี้มี presign/stat เท่านั้น) เพื่อให้งาน purge ลบไฟล์ใน S3 ได้ · ตอนนี้ลบได้เฉพาะ LocalStorage
- **A29 (billing)**: endpoint ยกเลิกแพ็กเกจ (ที่ทำให้ `subscriptions.status = 'canceled'`) — A31 ตรวจสถานะนี้ก่อนลบ Workspace
- **A04/auth**: Workspace ที่ `deleted_at` ไม่ว่างควรทำให้ session ของสมาชิกไม่ขึ้น Workspace นี้ในรายการ Workspace ของฉัน (`GET /me/workspaces`) — ปัจจุบัน `resolveTenant` กรองแล้ว แต่ควรตรวจรายการที่หน้าเว็บแสดง
- **W (N1)**: ปุ่ม "Export ทั้ง Workspace" poll `GET exports/:id` จน `ready` แล้วใช้ `downloadUrl` · "ลบ Workspace…" ส่ง `confirmSlug` · หน้าเลือก Workspace แสดง `GET workspaces/deleted` พร้อมปุ่มกู้คืน
- **D99**: เพิ่ม `POST data-requests`, `data-requests/:id/result`, `exports/:id/download`, `workspaces/deleted`, `workspaces/:slug/restore` ใน 03-api 3.3

### ผล test

`apps/api/test/privacy.e2e.test.ts` 13 ข้อ: สิทธิ์ (Member 403, Admin ดู support-access ได้แต่แก้ไม่ได้) · Export (202, zip ครบ: JSON/CSV/BOM/กัน injection/ไฟล์แนบ/คอมเมนต์/โปรเจกต์ Private/ไม่มีความลับ, ครั้งละหนึ่งงาน, ยังไม่เสร็จ, ผู้ขอไม่ใช่ Admin → failed, หมดอายุ → 410, cleanup ลบไฟล์) · PDPA (บันทึก/ซ้ำ/กรอง/ครบกำหนด/เปลี่ยนสถานะ, สำเนาข้อมูล, ลบข้อมูลต้องยืนยันอีเมล + นิรนาม + Session ถูกตัด, ผู้ขอหลาย Workspace ไม่ถูกทำนิรนาม, Owner คนเดียว 409) · support-access (เปิด/แก้/ปิด/หมดอายุ + Audit, ประวัติการเข้าเฉพาะของตัวเอง) · ลบ Workspace (สิทธิ์, ยืนยัน slug, แพ็กเกจที่ชำระ, เข้าไม่ได้หลังลบ, รายการกู้คืน, Owner เท่านั้นกู้คืน, เกิน 30 วัน 410, purge ลบข้อมูลทั้งหมดโดย Workspace อื่นไม่กระทบ) · `pnpm typecheck` ผ่าน · API 508 ผ่าน (ข้าม 6 = เดิม) · เพิ่ม dependency `fflate` ใน `apps/api` (zip)
