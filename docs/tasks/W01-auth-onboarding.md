# W01 · Login, สมัคร, ลืมรหัสผ่าน, รับคำเชิญ, Onboarding

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A13 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/(auth)/**` · `apps/web/messages/th/auth-onboarding.json` |
| หน้าจอ | J1 (`design/canvas/Login.dc.html`) · J2 (`design/canvas/Signup.dc.html`) · J3 (`design/canvas/ForgotPassword.dc.html`) · J4 (`design/canvas/AcceptInvite.dc.html`) · J5 (`design/canvas/Onboarding.dc.html`) · Q1 (`design/canvas/WorkspaceSwitch.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · 03-api › 3.1, 3.2 |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- ทุกขั้นตามหน้าจอ รวม 2FA, ยืนยันอีเมลด้วยรหัส 6 หลัก, ลิงก์เชิญหมดอายุ (410)
- Onboarding สร้าง Workspace → เชิญทีม → เริ่มโปรเจกต์ (ใหม่ / Import / ตัวอย่าง)

## เสร็จเมื่อ

- [x] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [x] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [x] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

- หน้าที่ทำ (ทั้งหมดอยู่ใน `app/(auth)/**` · ข้อความ namespace `auth-onboarding`):
  - J1 `/login`: อีเมล + รหัสผ่าน (แสดง/ซ่อน), จดจำ 30 วัน, บอกจำนวนครั้งที่เหลือก่อนล็อก / เวลาที่ปลดล็อก, 2FA รหัส 6 หลัก (วางทั้งรหัสได้) + Backup code + ไม่ถามอีก 30 วัน, Google / Microsoft ผ่าน `auth/oauth/{p}/start` พร้อม `next` / `remember`, แปลง `?error=oauth_*` เป็นข้อความ และรับ `#mfaToken` ที่ OAuth ส่งกลับมา · หลังเข้าสู่ระบบไป `returnTo` (กันลิงก์นอกเว็บ) → Workspace แรก → ไม่มีไป `/onboarding`
  - J2 `/signup`: แถบความแข็งแรง + เงื่อนไขรหัสผ่านตาม API, ยอมรับข้อกำหนด (PDPA), อีเมลซ้ำมีลิงก์เข้าสู่ระบบ · ขั้นยืนยันอีเมลด้วยรหัส 6 หลัก, ส่งใหม่เมื่อครบ 60 วินาที, "เปลี่ยนอีเมล" ใช้ `me/email:change` + `me/email:confirm` · ลิงก์ในอีเมล `/signup?token=` ยืนยันครั้งเดียว
  - J3 `/forgot-password`: ขอลิงก์ (ตอบเหมือนกันทุกกรณี) → ตรวจอีเมล → `?token=` ตั้งรหัสใหม่ตามนโยบายของ Workspace (`GET auth/password/reset`) + ยืนยันรหัส + ออกจากระบบทุกเครื่อง → สำเร็จ · ลิงก์เสีย/ใช้แล้วให้ขอใหม่
  - J4 `/join/[token]`: ผู้ใช้ใหม่สร้างบัญชีด้วยอีเมลที่ล็อกไว้แล้วตอบรับ, มีบัญชีแล้วเข้าร่วม/ปฏิเสธ, บัญชีอื่น (403) ออกแล้วเข้าสู่ระบบใหม่, หมดอายุ/ยกเลิก (410 ทั้งตอนเปิดและตอนกดตอบรับ), ถูกใช้แล้ว, ไม่พบ (404)
  - J5 `/onboarding`: สร้าง Workspace (slug จากชื่อ + ตรวจว่างแบบหน่วง) → ทีม → เชิญ (แยกส่งตาม Role เพราะ API รับ Role เดียวต่อคำขอ) → โปรเจกต์ตัวอย่าง (`projects/sample`) / Wizard / Import · ย้อนกลับหลังสร้างแล้วไม่สร้าง Workspace ซ้ำ
- สถานะ M1: กำลังโหลด (J3 ลิงก์, J4, J5), Error พร้อม requestId ทั้งตอนโหลดและในฟอร์ม, 403 = คำเชิญของอีเมลอื่น, 404/410 ของคำเชิญ · หน้าในกลุ่มนี้ยังไม่อยู่ในโปรเจกต์ จึงไม่มีปุ่มที่ต้องซ่อนตาม `my-permissions`
- ต่างจาก Canvas (ยังไม่มี API จึงไม่ทำปุ่มที่กดแล้วไม่เกิดอะไร): J5 ปุ่มอัปโหลดโลโก้, "ให้คนในโดเมนขอเข้าร่วม", ลิงก์เชิญแบบแชร์ และ chip Jira / Trello / Asana · J4 ปุ่ม "ขอคำเชิญใหม่" เปลี่ยนเป็นข้อความให้ติดต่อผู้เชิญ · J1 ปุ่ม SSO (SAML) แสดงแต่ปิดไว้ เพราะ SSO ยังไม่วางเป็นงาน · J4 เพิ่มช่องยอมรับข้อกำหนดเพราะ `auth/signup` บังคับ `acceptTerms` · ปุ่มปฏิเสธคำเชิญแสดงเฉพาะคนที่ล็อกอินอยู่ เพราะ `invitations/{token}/decline` ต้องล็อกอิน · J3 ไม่มีปุ่ม "(ตัวอย่าง) กดลิงก์ในอีเมล"
- คำตัดสิน: ขั้น "ทีมของคุณ" ยังไม่บันทึก (ไม่มี API) แต่ส่งวิธีทำงานต่อให้ Wizard เป็น `/w/{ws}/new-project?method=scrum|kanban|waterfall` · สมัครด้วย Google ส่ง `next=/onboarding` · ช่องและปุ่มสูง 44/46 px และกล่องรหัส 6 หลักตาม Canvas ผ่าน CSS module ของ lane (ใช้ `Input`, `Select`, `Button`, state ต่าง ๆ จาก UI kit)
- Test: `src/lib/auth-onboarding.test.tsx` 23 ข้อ (MSW) ครอบคลุมทุกข้อด้านบน · วางใต้ `src/` เพราะ vitest ค้นเฉพาะ `src/**/*.test.*` (เพิ่มไฟล์ใหม่ใน `src/lib` ได้ตาม README · แบบเดียวกับ W06)
- ตรวจกับ API จริง (ฐานแยก `friday_w01`, API `NODE_ENV=test` ส่งรหัสใน `x-dev-token`) ผ่านทุกขั้น: สมัคร → รหัสอีเมล → Onboarding 4 ขั้น → `/w/{ws}/p/DEMO` · Login ผิด/ถูก + `returnTo` · ผู้ใช้ใหม่รับคำเชิญ + เปิดลิงก์ซ้ำ · ลืมรหัสผ่านครบ + ลิงก์ใช้ซ้ำไม่ได้ · 2FA ด้วย TOTP และ Backup code
- เทียบภาพกับ Canvas ที่ 1440 × 960 และ 390 × 844 (Chrome) · ภาพหลังทำเสร็จอยู่ `app/(auth)/_qa/`
- `pnpm --filter @friday/web typecheck test build` ผ่าน (Web 76 ข้อ)
- คำขอนอก lane:
  - A14 / A18: API เก็บข้อมูล Onboarding (บทบาท, ขนาดทีม, วิธีทำงาน), อัปโหลดโลโก้ และ `allow_domain_join` ตอนสร้าง Workspace, ลิงก์เชิญแบบแชร์ และ "ขอคำเชิญใหม่" ที่แจ้ง Admin ใน Inbox
  - W13: อ่าน `?method=` เป็นค่าเริ่มต้นของ Wizard
  - W00: ยังไม่มี favicon (`/favicon.ico` ตอบ 404 ทุกหน้า)

