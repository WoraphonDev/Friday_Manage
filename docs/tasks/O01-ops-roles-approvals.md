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

- [x] test ครอบคลุมทุกข้อใน "ทำอะไร" · สิทธิ์แต่ละบทบาท (ได้ / 403) และกรณีเกินวงเงินที่ต้องสร้างคำขออนุมัติ
- [x] ทุกการกระทำกับลูกค้าเขียน Audit log พร้อมเหตุผล · error ใช้ `AppError` ข้อความไทย
- [x] `pnpm --filter @friday/ops-api typecheck` และ `test` ผ่าน · `pnpm typecheck` ที่รากผ่าน

## ไม่อยู่ในงานนี้

- หน้าเว็บ (O10, O14)

## บันทึกผล

### Module ใหม่ (lane ของงานถัดไป)

`app.module.ts` import ครบแล้ว งานอื่นเพิ่ม controller / provider ใน module ของตัวเองได้เลย: `workspaces` (O02), `users` (O02 · ว่าง), `payments` / `billing` (O03 · billing ว่าง), `support` / `system` (O04 · system ว่าง), `privacy` / `legal` (O05 · ว่าง), `metrics` (O06), `flags`, `staff`, `approvals` · `ops.controller.ts` ลบแล้ว · `Mailer` อยู่ใน `MailModule` (global) · `ApprovalsService` global

### Endpoint ใหม่

| Method | Path | บทบาท | หมายเหตุ |
|---|---|---|---|
| POST | `ops/auth/reauth/options` · `reauth/verify` | ทุกคน | ยืนยันตัวตนซ้ำ (G4) · cookie `fm_ops_re` อายุ 15 นาที |
| GET | `ops/approvals?status=` | ทุกคน | Owner เห็นทุกคำขอ · คนอื่นเห็นของตัวเอง · ตอบ `singleApprover` |
| POST | `ops/approvals/:id:approve` | Owner + ยืนยันซ้ำ | ทำรายการในนามผู้ขอ · ผู้ขออนุมัติเองได้เฉพาะช่วงมี Owner คนเดียว |
| POST | `ops/approvals/:id:reject` · `:cancel` | Owner · ผู้ขอ | |
| GET / POST | `ops/staff` | Owner, ผู้ตรวจ (อ่าน) · Owner (เชิญ) | เชิญได้ `enrollUrl` · เชิญ / เพิ่ม Owner ต้องยืนยันซ้ำ |
| PATCH | `ops/staff/:id` | Owner | บทบาท แผนก วงเงิน วันหมดอายุ · ถอด Owner คนสุดท้ายไม่ได้ |
| POST | `ops/staff/:id:status` · `:enroll-link` | Owner | active / suspended / disabled · ลิงก์ลงทะเบียนกุญแจใหม่ |
| DELETE | `ops/staff/:id/keys/:credentialId` | Owner + ยืนยันซ้ำ | ต้องเหลืออย่างน้อย 1 อัน |
| POST | `ops/staff/me/elevations` · `…/:id:end` | Owner + ยืนยันซ้ำ | 30 / 60 นาที · แจ้ง Owner และผู้ตรวจ |
| GET | `ops/audit` | Owner, ผู้ตรวจ | กรอง staffId, action (ขึ้นต้นด้วย), selfApproved, workspaceId · แบ่งหน้าด้วย `before` |

### พฤติกรรมที่เปลี่ยน

- guard: `roles[]` + บทบาทจากสิทธิ์ฉุกเฉิน · **ไม่มีบทบาทไหนผ่านทุกข้อ** · `@Roles()` ว่าง = เฉพาะ Owner · บัญชีที่ไม่ active หรือหมดอายุ → 401
- ส่วนลด (เกิน % / รอบ · ไม่ระบุรอบ = เกินเสมอ), ขยายทดลอง (รวมวัน / ครั้ง นับจาก Audit log ที่ service เขียนเอง) และระงับ Workspace ที่จ่ายเงิน → **202 `{ pendingApproval }`** · ระงับตามนโยบายค้างชำระ (`policy: 'overdue'`, ต้อง past_due) การเงินทำได้ทันที
- เข้าบัญชีลูกค้าโหมดแก้ไข: ช่วงมี Owner คนเดียวตอบ `write_mode_disabled` · ผู้อนุมัติคนที่สองต้องเป็น Owner ที่ใช้งานอยู่
- พนักงานที่เชิญใหม่เป็น `invited` · ลงทะเบียนกุญแจครบ 2 อันจึงเป็น `active` · ระหว่างนั้นล็อกอินได้ `enrollment_incomplete`
- `audit()` เขียนทั้ง `audit_logs` ของ Workspace และ `staff_audit_logs` (บทบาทตอนทำ, ผู้อนุมัติ, อนุมัติตัวเอง)
- `me` / login ยังส่ง `role` แบบเดิม (owner → admin) ให้ ops-web รุ่นปัจจุบันใช้ได้ · **ลบเมื่อ O10 merge**

### คำขอนอก lane (ทำแล้วในงานนี้)

- `packages/db`: migration `0019_staff_drop_legacy_role` ลบ `staff_users.role` และ trigger ชั่วคราวจาก O00 · ลบ test ของ trigger ใน `ops-phase1.test.ts` · fixture ใน `saas-rls.test.ts` ใช้ `roles`
- `apps/api/test/privacy.e2e.test.ts` เพิ่มพนักงานด้วย `roles`
- `docs/spec/01-entities.md` และ `docs/tasks/README.md` (สิทธิ์แก้ `apps/ops-api/test/helpers.ts`)

### ยังไม่ได้ทำ

- ส่งสรุปรายวันของรายการที่อนุมัติตัวเองถึงอีเมลส่วนตัว: มีข้อมูลครบใน `staff_audit_logs` (`self_approved`) แต่ ops-api ยังไม่มีตัวตั้งเวลา · ทำพร้อมคิวงาน / ตัวตั้งเวลาของ ops (O04)

### ทดสอบ

- ops-api 32 ข้อผ่าน (ใหม่ `staff.e2e.test.ts` 12 ข้อ · `ops.e2e.test.ts` ปรับ 3 ข้อตามกติกาใหม่) · `packages/db` 138 · API 613 · `pnpm typecheck` ผ่าน
- migrate 0019 บนฐาน QA `friday_canvas_qa` แล้ว

