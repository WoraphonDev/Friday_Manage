# A13 · ยืนยันอีเมล, ลืมรหัสผ่าน, 2FA, Google / Microsoft, Session

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | — เริ่มได้เลย |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/auth/**` · `apps/api/test/auth.e2e.test.ts` · route `me/mfa*`, `me/sessions*`, `me/identities*`, `me/password*`, `me/email*` (controller อยู่ใน `auth/`) |
| หน้าจอ | J1 (`design/canvas/Login.dc.html`) · J2 (`design/canvas/Signup.dc.html`) · J3 (`design/canvas/ForgotPassword.dc.html`) · I (`design/canvas/Profile.dc.html`) |
| สเปก | 03-api › 3.1 · 01-entities › A · docs/tech-stack.md (Email ปิดไว้ช่วงแรก, ยังไม่ทำ SAML) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- ยืนยันอีเมล: รหัส 6 หลัก + ลิงก์ (`auth_tokens`) · resend ทุก 60 วินาที
- ลืมรหัสผ่าน: `forgot` ตอบ 202 เสมอ · `reset` เลือกออกจากระบบทุกเครื่องได้
- Login + 2FA: `mfaToken` → `POST auth/login/mfa` (TOTP หรือ Backup code, `trustDevice` 30 วัน) · `me/mfa:setup / enable / disable / backup-codes:regenerate` · ปิดไม่ได้ถ้า `security_policies` บังคับ
- OAuth Google และ Microsoft (Authorization Code + PKCE) · อีเมลตรงบัญชีเดิม → ผูก `user_identities` · `GET / DELETE me/identities` (ลบวิธีสุดท้ายไม่ได้)
- `GET / DELETE me/sessions` · `POST me/password:change`, `me/email:change` · Audit `secu.*`
- ล็อกเมื่อใส่ผิดตาม `security_policies` ที่เข้มที่สุดของ Workspace ที่ผู้ใช้อยู่ (แทนค่าคงที่ใน config)
- ส่งอีเมลผ่าน `Mailer` (core/mail.ts) · เมื่อ `NODE_ENV=test` คืนรหัส / token ใน header `x-dev-token` ให้ test อ่านได้

## กติกาที่ต้องตรง

- `auth.guard.ts` และ `sessions.ts` อยู่ใน lane นี้ · CSRF และ Session ของเดิมต้องทำงานเหมือนเดิม

## เสร็จเมื่อ

- [x] test ครอบคลุมทุกข้อ (OAuth ทดสอบด้วย provider ปลอมใน test)
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- SSO / SAML (ยังไม่วางเป็นงาน)
- API token (A28)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

- **ยืนยันอีเมล (J2):** `auth/signup` ออกรหัส 6 หลัก + ลิงก์ (`auth_tokens` 2 แถวต่อครั้ง) แล้วส่งผ่าน `Mailer` · `POST auth/verify-email` รับ `{ token }` (ลิงก์ ไม่ต้องล็อกอิน) หรือ `{ email?, code }` (ไม่ส่ง email ใช้บัญชีที่ล็อกอินอยู่) · `POST auth/verify-email:resend` ทุก 60 วินาที (`429 resend_too_soon` + `details.retryAfter`) อีเมลที่ไม่มีบัญชีตอบ 202 เหมือนกัน · รหัสผิด 5 ครั้ง รหัสและลิงก์ที่ค้างอยู่ใช้ไม่ได้ ต้องขอใหม่
- **ลืมรหัสผ่าน (J3):** `POST auth/password/forgot` ตอบ 202 `{ retryAfter: 60 }` เสมอ ขอซ้ำใน 60 วินาทีไม่ส่งใหม่ · ลิงก์อย่างเดียวตามหน้าจอ อายุ 30 นาที · เพิ่ม `GET auth/password/reset?token=` ให้หน้า "ตั้งรหัสผ่านใหม่ สำหรับ …" ได้อีเมลและกติการหัสผ่านโดยยังไม่ใช้ลิงก์ · `POST auth/password/reset { token, newPassword, logoutAll = true }` ตรวจรหัสก่อนใช้ลิงก์ (ใส่รหัสไม่ผ่านแล้วแก้ส่งใหม่ได้) · ล้างการล็อก, ถือว่ายืนยันอีเมลแล้ว, ส่งอีเมลแจ้ง, Audit `secu.password_reset`
- **Login + 2FA (J1):** เปิด 2FA อยู่ `auth/login` ตอบ 200 `{ mfaRequired: true, mfaToken, email }` แทนการเปิด Session · `POST auth/login/mfa { mfaToken, code, trustDevice }` รับ TOTP หรือ Backup code · รหัส 2FA ผิดนับรวมกับการล็อกบัญชี (`401 invalid_mfa_code` + `attemptsLeft`) · ใช้ Backup code ตอบ `backupCodesLeft` และ Audit `secu.backup_code_used`
- **Profile › 2FA:** `GET me/mfa` (เพิ่มเอง: `enabled, backupCodesLeft, setupPending, requiredByPolicy`) · `POST me/mfa:setup` → `{ secret, otpauthUrl }` · `me/mfa:enable { code }` → Backup code 10 รหัส (แสดงครั้งเดียว) · `me/mfa:disable { code }` · `me/mfa/backup-codes:regenerate { code }` · ปิดไม่ได้เมื่อ `mfa_enforcement = all` หรือ `admin` และเป็น Owner / Admin ของ Workspace ใดก็ตาม (`403 mfa_required_by_policy`)
- **OAuth (Google, Microsoft):** `GET auth/oauth/{provider}/start?next=&remember=&mode=link` → 302 ไป provider (Authorization Code + PKCE S256, `prompt=select_account`) · `GET auth/oauth/{provider}/callback` แลก code (ส่ง `code_verifier`) แล้วอ่าน OIDC userinfo · ผลทุกกรณี redirect ไปเว็บ: สำเร็จไป `next`, ผิดพลาด `?error=` (`oauth_state_mismatch`, `oauth_cancelled`, `oauth_failed`, `oauth_email_unverified`, `identity_in_use`, `account_disabled`) · เปิด 2FA → `/login#mfaToken=…&email=…&next=…` แล้วเรียก `auth/login/mfa` ต่อ · `mode=link` ผูกกับบัญชีที่ล็อกอินอยู่ (หน้า Profile) redirect กลับพร้อม `?linked=google` · provider ที่ไม่ได้ตั้งค่าตอบ `404 oauth_provider_unavailable`
- **วิธีเข้าสู่ระบบ:** `GET me/identities` (รายการ + `canDelete` + `passwordChangedAt` ของรหัสผ่าน) · `DELETE me/identities/{id}` ลบวิธีสุดท้ายไม่ได้ (`409 last_login_method`) · ลบ "รหัสผ่าน" = ล้าง `password_hash` · Audit `secu.identity_linked` / `secu.identity_unlinked`
- **Session:** `GET me/sessions` (`deviceName` เช่น "Chrome · macOS", `lastSeenAt`, `mfaTrustedUntil`, `current`) · `DELETE me/sessions/{id}` (ลบเครื่องนี้ = ล้างคุกกี้ด้วย) · `DELETE me/sessions` ออกจากเครื่องอื่นทั้งหมด `{ revoked }` · Audit `secu.session_revoked`
- **รหัสผ่าน / อีเมล:** `POST me/password:change { currentPassword, newPassword, logoutOthers = true }` (บัญชีที่มีแค่ Google / Microsoft ตั้งรหัสครั้งแรกได้โดยไม่ต้องใส่รหัสเดิม) Audit `secu.password_changed` + อีเมลแจ้ง · `POST me/email:change { newEmail, password }` ส่งรหัส + ลิงก์ไปอีเมลใหม่ (202) · เพิ่ม `POST me/email:confirm { code | token }` · ลิงก์ในอีเมลใหม่ใช้ `auth/verify-email { token }` ได้ด้วย · เปลี่ยนแล้วแจ้งอีเมลเดิม Audit `secu.email_changed`
- **security_policies:** ใช้ค่าที่เข้มที่สุดจากทุก Workspace ที่เป็นสมาชิก active แทนค่าคงที่ใน config: `lockout_attempts` (น้อยสุด), `lockout_minutes` (มากสุด), `password_min_length` / `password_require_special` (ใช้ตอน reset และ password:change · ไม่มี Workspace ใช้กติกา J2), `session_idle_hours` (น้อยสุด · ใน `SessionService.find`) · ค่าเริ่มต้นตรงกับ config เดิม Session / CSRF จึงทำงานเหมือนเดิม (`auth.guard.ts` ไม่แก้) · `details` ของ `invalid_credentials` เพิ่ม `lockoutMinutes` ให้หน้า J1 แสดง "ล็อก 15 นาที"
- **Audit `secu.*`:** `audit_logs` ผูก `workspace_id` จึงบันทึกลงทุก Workspace ที่ผู้ใช้เป็นสมาชิก active · ผู้ใช้ที่ยังไม่มี Workspace ไม่มีที่บันทึก · `secu.login_failed` บันทึก `actor_kind = system` (ยังไม่รู้ว่าใครเป็นคนลอง)
- **การเก็บความลับ:** ลิงก์เก็บเป็น sha256 · รหัส 6 หลักและ Backup code เก็บเป็น HMAC-SHA256 (ผูก user_id) · secret ของ TOTP เข้ารหัส AES-256-GCM ใน `secret_enc` · `mfaToken`, state ของ OAuth และคุกกี้จำอุปกรณ์เป็น token ลงลายมือชื่อ HMAC (ไม่เก็บในฐานข้อมูล) · กุญแจย่อยแยกตามงานด้วย HKDF จาก `AUTH_SECRET` · เทียบค่าด้วย `timingSafeEqual` · Backup code ลบจาก array แบบ atomic (`array_remove` + `= any`) ใช้ซ้ำไม่ได้ · TOTP (RFC 6238 เขียนเองด้วย `node:crypto` ไม่เพิ่ม dependency) ยอม ±1 step และห้ามใช้ step เดิมซ้ำ
- **จำอุปกรณ์ 30 วัน:** ตาราง `user_sessions` มีแค่ `mfa_trusted_until` จึงให้คุกกี้ `fm_mfa_trust` (httpOnly) ชี้ไปที่ Session ที่ผ่าน 2FA · เข้าใหม่ด้วยรหัสผ่านบนอุปกรณ์เดิมไม่ถาม 2FA และย้ายการจำไป Session ใหม่ · "ออกจากระบบ" ในหน้า Profile, reset / เปลี่ยนรหัสผ่าน (ออกจากเครื่องอื่น) และปิด 2FA ล้างการจำด้วย
- **คำตัดสินที่เลือกเอง:** อีเมลจาก provider ที่ระบุ `email_verified = false` ไม่ผูกกับบัญชีเดิม (กันยึดบัญชี) · ไม่มีฟิลด์นี้ (Microsoft) ถือว่ายืนยันแล้ว · OAuth สำเร็จล้างการล็อกจากการใส่รหัสผ่านผิด · บัญชีที่สมัครผ่าน OAuth ใช้ชื่อจาก provider และยังไม่บันทึกการยอมรับข้อกำหนด (เป็นงานของ `me/legal-acceptances`) · `mfa:disable` และ `backup-codes:regenerate` ต้องใส่รหัสจากแอปหรือ Backup code · `email:change` ต้องใส่รหัสผ่าน (ถ้ามี) · ยังไม่บังคับยืนยันอีเมลก่อนใช้งานเพราะการส่งอีเมลยังปิดอยู่
- **ข้อจำกัด:** ตัวนับรหัส 6 หลักที่ผิดและ step ล่าสุดของ TOTP เก็บในหน่วยความจำของ process (ตารางไม่มีคอลัมน์) · ถ้ารันหลายเครื่องควรย้ายไป Valkey (A16) · ยังไม่ทำ "บังคับตั้ง 2FA ตอนล็อกอิน" เมื่อ Workspace บังคับแต่ผู้ใช้ยังไม่เปิด (สเปกไม่ได้ระบุ endpoint)
- **env ใหม่:** `AUTH_SECRET` (ต้องตั้งใน production อย่างน้อย 32 ตัว · dev / test ใช้ค่าตายตัว) · `WEB_URL` (ลิงก์ในอีเมล + redirect หลัง OAuth · ค่าเริ่มต้น `http://localhost:3000`) · `API_PUBLIC_URL` (redirect_uri · ค่าเริ่มต้น `http://localhost:$PORT`) · `OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_GOOGLE_CLIENT_SECRET`, `OAUTH_MICROSOFT_CLIENT_ID`, `OAUTH_MICROSOFT_CLIENT_SECRET` และ `OAUTH_{GOOGLE|MICROSOFT}_{AUTHORIZE|TOKEN|USERINFO}_URL` (ค่าเริ่มต้นเป็น endpoint จริง · test ชี้ไป provider ปลอม) · ไม่มี secret จริงใน repo
- **x-dev-token:** เฉพาะ `NODE_ENV=test` · รหัส 6 หลักอยู่ใน `x-dev-token` ลิงก์อยู่ใน `x-dev-link-token` · reset password มีแต่ลิงก์จึงอยู่ใน `x-dev-token`
- **ผลตรวจ:** `pnpm typecheck` และ `pnpm test` ผ่าน (web 52, DB 105, API 118 ผ่าน + 2 skip เดิม) · `auth.e2e.test.ts` 19 tests: ยืนยันอีเมล, resend, ผิด 5 ครั้ง, forgot / reset ตามนโยบาย, x-dev-token นอก test, ล็อกตามนโยบาย, 2FA ทั้งวงจร, trustDevice, Backup code, นโยบายบังคับ 2FA, Session รายเครื่อง / ทั้งหมด / idle ตามนโยบาย, CSRF, เปลี่ยนรหัสผ่าน / อีเมล, OAuth สมัครใหม่ / ผูกด้วยอีเมล / ผ่าน 2FA / email_verified=false / state ผิด / open redirect / mode=link / identity_in_use / ลบวิธีสุดท้าย · OAuth ใช้ HTTP server ปลอมในเครื่องที่ตรวจ PKCE, client และ redirect_uri · ใช้ฐานทดสอบแยก `friday_a13`
- **คำขอนอก lane:** (1) `config.ts`: ย้ายค่า `lockoutAttempts` / `lockoutMinutes` / `sessionIdleHours` ให้ชัดว่าเป็นค่าสำรองเมื่อไม่มี Workspace (ตอนนี้คอมเมนต์ยังบอกว่า "ภายหลังอ่านจาก security_policies") · (2) `.env.example` / `apps/api/README.md` (D99): เพิ่ม env ข้างบน · (3) T00: ถ้าต้องรันหลายเครื่อง ควรมีคอลัมน์นับรหัสผิดใน `auth_tokens` และ `last_used_step` ใน `mfa_factors` แทนหน่วยความจำ · (4) `GET me` (A20) อาจเพิ่ม `mfaEnabled` / `passwordChangedAt` ให้หน้า I ไม่ต้องเรียก `me/mfa` และ `me/identities` แยก
- **คำถามที่ค้าง:** เส้นทางหน้าเว็บของลิงก์ในอีเมล (W01) ตอนนี้ใช้ `WEB_URL/signup?token=` (ยืนยันอีเมล / อีเมลใหม่) และ `WEB_URL/forgot-password?token=` (ตั้งรหัสใหม่) · หน้า OAuth error / `#mfaToken` อยู่ที่ `/login` · ถ้า W01 ใช้เส้นทางอื่นแก้ที่ `auth.controller.ts` / `me-security.controller.ts` / `oauth.controller.ts`
