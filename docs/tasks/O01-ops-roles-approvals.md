# O01 · ops-api: แยก module, บทบาทหลายบทบาท, วงเงิน, การอนุมัติ, สิทธิ์ฉุกเฉิน, พนักงาน

| | |
|---|---|
| Wave | O-1 |
| รอ merge | O00 |
| Lane (แก้ได้เฉพาะ) | `apps/ops-api/src/{app.module.ts,ops.controller.ts,auth,staff,approvals,audit.ts}` · `apps/ops-api/test/staff.e2e.test.ts` |
| หน้าจอ | Staff · Modals-Global (G4, G5, G6, G7, G8, G12) · Modals-Security (A1, A2, A12) · Modals-States (S1–S3) |
| สเปก | [06-ops-roles](../spec/06-ops-roles.md) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน · หน้าจอทั้งหมดของ Friday Ops อยู่ใน `design/canvas/ops/` (สำเนาของ [Canvas Friday Ops](https://claude.ai/artifact/Q8tsmLfQqS1aUJ2rNrkw9r) รุ่นที่ 40) · ทำเฉพาะสิ่งที่ติดป้าย **เฟส 1**

## ทำอะไร

- **ทำก่อนงาน ops อื่น:** แยก `ops.controller.ts` เป็น module ต่อเรื่อง (workspaces, payments, support, system, privacy, metrics) แล้วย้าย endpoint เดิมไปไว้ใน module ของมันโดยไม่เปลี่ยนพฤติกรรม เพื่อให้งาน O02–O06 มี lane แยกกัน
- guard: `roles[]` แทน `role` · เลิกให้ admin ผ่านทุกอย่าง · นับบทบาทจาก `staff_elevations` ที่ยังไม่หมดเวลา
- `@Approval(kind)`: ตรวจวงเงินของผู้ทำ เกินแล้วสร้าง `approval_requests` แทนการทำรายการ · อนุมัติ / ไม่อนุมัติ / หมดอายุ · ผู้ขออนุมัติของตัวเองไม่ได้ ยกเว้นช่วงมี Owner คนเดียว (ติด `self_approved` ส่งสรุปรายวัน) · ห้ามอนุมัติตัวเองสำหรับโหมดแก้ไขและลบข้อมูล PDPA
- ยืนยันตัวตนซ้ำด้วย WebAuthn เมื่อยืนยันล่าสุดเกิน 15 นาที (G4)
- พนักงาน: เชิญ (ลิงก์ลงทะเบียน 2 กุญแจ), แก้บทบาท แผนก วงเงิน, ระงับ, ปิดบัญชี, ออกลิงก์ลงทะเบียนกุญแจใหม่ · เพิ่มบทบาท Owner ต้องยืนยันตัวตนซ้ำ
- สิทธิ์ฉุกเฉิน: เปิด 30 / 60 นาที พร้อมเหตุผล · แจ้งอีเมลส่วนตัวของ Owner และผู้ตรวจ
- Audit log ของทีม Friday: บันทึก roles ตอนทำ, approved_by, self_approved · ค้นและกรองได้

## เสร็จเมื่อ

- [ ] test ครอบคลุมทุกข้อใน "ทำอะไร" · สิทธิ์แต่ละบทบาท (ได้ / 403) และกรณีเกินวงเงินที่ต้องสร้างคำขออนุมัติ
- [ ] ทุกการกระทำกับลูกค้าเขียน Audit log พร้อมเหตุผล · error ใช้ `AppError` ข้อความไทย
- [ ] `pnpm --filter @friday/ops-api typecheck` และ `test` ผ่าน · `pnpm typecheck` ที่รากผ่าน

## ไม่อยู่ในงานนี้

- หน้าเว็บ (O10, O14)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
