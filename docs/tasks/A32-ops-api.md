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

- [ ] test ครอบคลุมทุกข้อ
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- หน้าเว็บ (W20)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
