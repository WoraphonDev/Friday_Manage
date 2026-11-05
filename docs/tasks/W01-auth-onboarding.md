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

- [ ] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [ ] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [ ] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [ ] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
