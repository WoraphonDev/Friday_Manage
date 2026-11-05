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

- [ ] test ครอบคลุมทุกข้อ (OAuth ทดสอบด้วย provider ปลอมใน test)
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- SSO / SAML (ยังไม่วางเป็นงาน)
- API token (A28)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
