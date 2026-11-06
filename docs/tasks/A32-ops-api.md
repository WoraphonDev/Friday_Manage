# A32 · หลังบ้านทีม Friday (แอปแยก)

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | T00, A29 |
| Lane (แก้ได้เฉพาะ) | `apps/ops-api/**` (แอปใหม่) |
| หน้าจอ | Q3 (`design/canvas/SuperAdmin.dc.html`) |
| สเปก | 03-api › 3.12 · 01-entities › N |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- NestJS แอปแยก ใช้ `@friday/db` ผ่านบัญชีของ ops (ไม่ใช่ friday_app)
- ล็อกอินด้วย Security key (WebAuthn) ของ `staff_users`
- ทุก endpoint ใน 3.12 · ทุกคำขอเขียน `audit_logs` ของ Workspace ที่แตะ · support session ต้องมี grant, เลข Ticket, เหตุผล และผู้อนุมัติคนที่ 2 สำหรับโหมดแก้ไข

## เสร็จเมื่อ

- [x] test ครอบคลุมทุกข้อ
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- หน้าเว็บ (W20)

## บันทึกผล

### แอปใหม่ `apps/ops-api` (`@friday/ops-api`) · NestJS แยกจาก `apps/api`

รัน: `pnpm --filter @friday/ops-api dev` (พอร์ต `OPS_PORT`, ค่าเริ่มต้น 3002) · ทดสอบ: `pnpm --filter @friday/ops-api test` · ลงทะเบียนพนักงานคนแรก: `pnpm --filter @friday/ops-api enroll <email> [ชื่อ] [admin|support|finance]` (สร้างแถว `staff_users` ถ้ายังไม่มี แล้วพิมพ์โทเค็นลงทะเบียน Security key ใช้ได้ 1 ชั่วโมง)

**ฐานข้อมูล**: ใช้ `@friday/db` ผ่าน `OPS_DATABASE_URL` (ถ้าไม่ตั้ง ใช้ `DATABASE_SYSTEM_URL` = `friday_worker` ของ dev) — ต้องเป็น role ที่ข้าม RLS ได้ ไม่ใช่ `friday_app` · production ควรสร้าง role แยก `friday_ops` (ดู "คำขอนอก lane")

### Auth (Security key / WebAuthn · `@simplewebauthn/server`)

| Method | Path | หมายเหตุ |
|---|---|---|
| POST | `ops/auth/register/options` · `register/verify` | ลงทะเบียน key: ด้วย `enrollToken` (พนักงานใหม่) หรือขณะล็อกอินอยู่ (เพิ่ม key สำรอง) · attestation `none` · key ซ้ำ → 409 |
| POST | `ops/auth/login/options` · `login/verify` | challenge เซ็นเป็นโทเค็นอายุ 5 นาที (ไม่เก็บฝั่งเซิร์ฟเวอร์) · **counter ต้องเพิ่มขึ้น** (เล่นซ้ำ / โคลน key ไม่ผ่าน) · origin / RP ID ผิดไม่ผ่าน · อีเมลที่ไม่มีตอบ options รูปแบบเดียวกัน (ไม่เปิดเผยตัวตน) · สำเร็จ → cookie `fm_ops` HttpOnly, **SameSite=Strict**, 8 ชม. |
| GET / POST | `ops/auth/me` · `logout` | ทุกคำขอ (global guard) ตรวจ session กับ `staff_users` ในฐานข้อมูล — ลบพนักงานแล้วใช้ต่อไม่ได้ · คำขอเขียนที่มี `Origin` ต้องตรง `OPS_WEB_ORIGIN` (403 `bad_origin`) |

### Endpoint ตาม 03-api 3.12

| Method | Path | บทบาท |
|---|---|---|
| GET | `ops/metrics` | ทุกคน · `mrr` (ใบแจ้งหนี้ที่ชำระแล้วล่าสุดของ Workspace ที่ active, รายปี ÷ 12, ไม่รวมภาษี), `payingWorkspaces`, `trialing`, `trialExpired`, `canceledLast30Days`, `pastDue`, `pendingPayments`, `suspended`, `paidLast30Days`, `workspaces`, `newWorkspacesLast30Days`, `byPlan` |
| GET | `ops/workspaces?plan&status&q` · `ops/workspaces/:id` | ทุกคน · รายละเอียด: owner/admin, การใช้งาน, subscription, grant, support session ล่าสุด, ใบแจ้งหนี้ |
| POST | `ops/workspaces/:id/support-sessions` (+ `GET ops/support-sessions` รายการที่เปิดอยู่, `POST ops/support-sessions/:id:end`) | support · **ต้องมี grant จากลูกค้า** (ไม่หมดอายุ, `max_mode` รองรับ) · `ticketNo`, `reason` ≥ 10 ตัว · โหมด `write` ต้องมี `secondApproverId` เป็นพนักงานอื่น · แจ้ง Owner/Admin ทางอีเมลทันที (เมื่อลูกค้าเปิด "แจ้งเมื่อมีการเข้า") · จบ session: เจ้าของ session หรือ admin |
| POST | `ops/workspaces/:id:extend-trial` | support · เฉพาะที่กำลังทดลอง · 1–60 วัน |
| POST | `ops/workspaces/:id:discount` · `:change-plan` | finance · ส่วนลด % + จำนวนรอบ · เปลี่ยนแพ็กเกจเป็น active ทันที (ไม่ออกใบแจ้งหนี้) |
| POST | `ops/workspaces/:id:suspend` · `:resume` | admin · `workspaces.status = suspended` / `active` |
| GET | `ops/payments?status=pending_review` · `payments/:id/slip` | finance |
| POST | `ops/payments/:id:confirm` · `:reject` | finance · confirm: payment `confirmed`, invoice `paid`, **เปิดแพ็กเกจตามที่สั่งซื้อ**, สร้าง `tax_documents` (pending) · reject: invoice กลับเป็น `open`, **เลิกสิทธิ์แพ็กเกจที่ A33 เปิดไว้ชั่วคราวด้วยใบนี้**, อีเมลแจ้งพร้อมเหตุผล |
| GET / POST | `ops/wht-certificates/:id/file` · `:confirm` · `:reject` | finance · 50 ทวิ (ปฏิเสธต้องมีเหตุผลและแจ้งลูกค้า) |
| CRUD | `ops/feature-flags` · `PUT/DELETE ops/feature-flags/:id/overrides/:workspaceId` | admin · override ต่อ Workspace เขียน Audit ของ Workspace นั้น |
| CRUD | `ops/announcements` · `POST :id:publish` | admin · ส่งแล้วแก้ไม่ได้ |

**ทุกคำขอเขียนที่แตะ Workspace เขียน `audit_logs` ของ Workspace นั้น** ด้วย `actor_kind = friday_staff`, `actor_id` = พนักงาน และ summary ขึ้นต้น `[Friday <ชื่อ>]` (ลูกค้าเห็นในหน้า Audit log ของ A18) · การแก้ฟีเจอร์ flag / ประกาศ (ไม่ผูก Workspace) ไม่มีที่เก็บ audit ในสคีมาปัจจุบัน

### บทบาท (ใหม่ — สเปกไม่ได้กำหนด)

`staff_users.role`: `admin` (ทุกอย่าง) · `support` (ดูลูกค้า, เข้าช่วยเหลือ, ต่อช่วงทดลอง) · `finance` (ชำระเงิน, ส่วนลด, เปลี่ยนแพ็กเกจ) — บทบาทที่ไม่ตรงได้ 403 `forbidden` พร้อม `details.need`

### คำตัดสินที่เลือกเอง

- **session ไม่เก็บตาราง** (โทเค็น HMAC + ตรวจแถว `staff_users` ทุกคำขอ): ไม่มีตาราง session ของหลังบ้าน (migration นอก lane) · ข้อจำกัด: logout เพียงล้าง cookie ฝั่งผู้ใช้ — โทเค็นที่ถูกขโมยใช้ได้จนครบ 8 ชม. หรือจนลบพนักงาน
- ไม่มี rate limit ที่ `login/options|verify` (ให้ reverse proxy / WAF ทำ — ดู I01)
- สลิป / 50 ทวิ อ่านจากโฟลเดอร์ `UPLOAD_DIR` ตัวเดียวกับ `apps/api` (ค่าเริ่มต้น `../api/var/uploads`) · **ที่เก็บ S3 ยังไม่รองรับ**
- แพ็กเกจที่สั่งซื้อ / รอบของใบแจ้งหนี้อ่านจากแถว `audit_logs` `billing.checkout` ที่ A33 เขียนไว้ (ดูบันทึก A33)
- ใบกำกับภาษีที่หลังบ้านสร้าง (pending) ถูก **A33 เพิ่มงาน `payments.etax-sweep` (ทุก 10 นาที)** ไปส่งผู้ให้บริการ e-Tax — แก้เล็กน้อยใน `apps/api/src/payments/payments.service.ts` + test 1 ข้อ
- ประกาศ: `:publish` แค่ตั้ง `sent_at` · การแสดง banner / ส่งอีเมลจริงเป็นงานของ API ลูกค้า (ยังไม่มี)

### คำขอนอก lane

- **apps/api (ผู้ดูแล TenantGuard/Auth)**: Workspace ที่ `status = suspended` ต้องถูกปฏิเสธ (เช่น 403 `workspace_suspended`) — ตอนนี้ `suspend` เปลี่ยนสถานะแล้วแต่ API ลูกค้ายังไม่ตรวจ · feature flag / override ยังไม่ถูกอ่านที่ฝั่งลูกค้า · ประกาศ banner ยังไม่มี endpoint อ่าน
- **T00 / I01**: สร้าง role ฐานข้อมูล `friday_ops` (LOGIN, BYPASSRLS, สิทธิ์เฉพาะตารางที่หลังบ้านใช้: workspaces, subscriptions, plans, invoices, payments, tax_documents, wht_certificates, support_*, staff_users, feature_flag*, announcements, audit_logs INSERT/SELECT, users/workspace_members SELECT) แล้วตั้ง `OPS_DATABASE_URL` · ตั้ง `OPS_AUTH_SECRET` (≥ 32 ตัว), `OPS_RP_ID` (เช่น `ops.friday.app`), `OPS_WEB_ORIGIN` (เช่น `https://ops.friday.app`), `UPLOAD_DIR`/storage ร่วมกับ API, `SMTP_*` · เพิ่มแอปนี้ใน pipeline deploy
- **W20 (ops-web)**: ใช้ `@simplewebauthn/browser` — `startRegistration(options)` / `startAuthentication(options)` แล้วส่ง `challengeToken` + `response` กลับ · ส่ง cookie (`credentials: 'include'`) และตั้ง CORS เฉพาะ origin ของ ops-web
- **A33**: การเปลี่ยนสถานะ invoice/payment ที่หลังบ้านทำ (confirm/reject) ไม่ส่ง Event ใด ๆ — ถ้าจะให้ลูกค้าได้ Notification ในแอป ต้องเพิ่มทางเข้าใน API ลูกค้า (ตอนนี้แจ้งทางอีเมล)
- **.env.example**: `OPS_PORT`, `OPS_DATABASE_URL`, `OPS_AUTH_SECRET`, `OPS_RP_ID`, `OPS_WEB_ORIGIN`
- **D99**: เพิ่ม `ops/auth/*`, `payments/:id/slip`, `wht-certificates/*`, `support-sessions` (GET), `workspaces/:id:resume`, `announcements/:id:publish`, `feature-flags/:id/overrides/:workspaceId` ใน 03-api 3.12 และตารางบทบาท

### ผล test

`apps/ops-api/test/ops.e2e.test.ts` 17 ข้อ ใช้ **Security key จำลองในโค้ด** (`test/authenticator.ts`: ES256 + CBOR + attestation `none` ตามสเปก WebAuthn) ผ่านไลบรารีตรวจจริง: 401 ทุก endpoint ถ้าไม่มี session · ลงทะเบียน key (โทเค็นหมดอายุ / ผิด purpose, challenge ผิด, origin ผิด, key ซ้ำ) · ล็อกอิน (cookie flags, **เล่นซ้ำคำตอบเดิมไม่ผ่าน**, key แปลก, challenge ไม่ตรง, origin ฟิชชิ่ง, อีเมลไม่มี) · session (cookie ปลอม, Origin แปลก, logout, ลบพนักงาน) · บทบาท · metrics (MRR รายปี ÷ 12, ใบที่ยังไม่ชำระไม่นับ) · รายการ/รายละเอียด Workspace · support session ทุกกฎ (ไม่มี/หมดอายุ grant, โหมด, ผู้อนุมัติคนที่ 2, ซ้ำ, จบ, อีเมล, Audit, ปิดแจ้งเตือน) · ต่อทดลอง / ส่วนลด / เปลี่ยนแพ็กเกจ / ระงับ / เปิด + Audit · ตรวจสลิป (ดาวน์โหลด, ยืนยันเปิดแพ็กเกจ + ใบกำกับภาษี, ปฏิเสธเลิกสิทธิ์ + อีเมล) · 50 ทวิ · flag + override + ประกาศ · `pnpm typecheck` ผ่านทั้ง monorepo · `pnpm test` ผ่านทุกแพ็กเกจ (API 522, ops-api 17) · เพิ่ม dependency `@simplewebauthn/server`, `nodemailer` ใน `apps/ops-api`
