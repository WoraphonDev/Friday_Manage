# O00 · ตารางของ Friday Ops เฟส 1 และข้อมูลธุรกิจ

| | |
|---|---|
| Wave | O-0 · เริ่มได้ทันที |
| รอ merge | — |
| Lane (แก้ได้เฉพาะ) | `packages/db/**` |
| หน้าจอ | Staff, Billing, Support, Operations, Business, Modals-* |
| สเปก | 06-ops-roles › 6 · 05-business-metrics › 1 · 01-entities › M, N |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน · หน้าจอทั้งหมดของ Friday Ops อยู่ใน `design/canvas/ops/` (สำเนาของ [Canvas Friday Ops](https://claude.ai/artifact/Q8tsmLfQqS1aUJ2rNrkw9r) รุ่นที่ 40) · ทำเฉพาะสิ่งที่ติดป้าย **เฟส 1**

## ทำอะไร

- `staff_users`: เปลี่ยน `role` เป็น `roles text[]` (owner · finance · support · engineer · auditor) + `department`, `limits jsonb`, `status`, `expires_at` · ย้ายข้อมูลเดิม admin → {owner}
- `staff_elevations` (สิทธิ์ฉุกเฉิน) · `approval_requests` (kind, payload, amount, requested_by, decided_by, status, self_approved, reason, expires_at)
- `staff_audit_logs` สำหรับการกระทำที่ไม่ผูก Workspace (พนักงาน บทบาท ตั้งค่า) · append-only แบบ `audit_logs`
- `support_tickets`, `support_ticket_messages` (คิวกลาง · ผู้รับผิดชอบ · สถานะ · SLA due) · ผูก `support_sessions.ticket_id`
- `incidents`, `incident_updates`, `maintenance_windows`, `status_subscribers`
- เงิน: `credit_notes`, `workspace_credits`, `dunning_events` · `payments` เพิ่ม `verified_by` (webhook · bank · slip_api · staff), `exception_reason`, `matched_invoice_id`
- ข้อมูลธุรกิจตาม 05 › 1: `signup_attributions`, `workspace_acquisitions`, `product_events` (partition รายเดือน), `subscription_changes`, `cancellation_responses`, `daily_usages`, `cost_rates`, `infra_costs`, `marketing_costs`
- RLS: ตารางที่มี `workspace_id` เปิด RLS ตามธรรมเนียม · ตารางระดับระบบให้สิทธิ์เฉพาะบัญชี ops

## เสร็จเมื่อ

- [x] migration ใหม่ต่อจาก 0016 รันซ้ำได้บนฐานข้อมูลที่มีข้อมูล (ห้ามล้าง)
- [x] test RLS ของตารางใหม่ผ่าน · constraint `support_sessions_write_approval` คงไว้
- [x] `pnpm db:migrate` บนฐานข้อมูลทดสอบเดิมผ่าน · `pnpm typecheck` และ `pnpm test` ผ่าน

## ไม่อยู่ในงานนี้

- endpoint และหน้าจอ (O01–O06, O10–O15)

## บันทึกผล

### Migration

- `0017_ops_phase1.sql` (`drizzle-kit generate`): 21 ตารางใหม่ + คอลัมน์ใหม่ใน `staff_users`, `payments`, `support_sessions` · แทรก `UPDATE` ย้ายบทบาทเดิมก่อนบังคับ constraint `staff_users_roles_valid`
- `0018_ops_phase1_rls.sql` (เขียนเอง): RLS ครบทุกตารางใหม่, สิทธิ์ของ `friday_app`, trigger `touch`, trigger `staff_users_sync_roles`, `staff_audit_logs` append-only แม้ role ของ ops

### ต่างจากไฟล์งาน / สเปก

- **คง `staff_users.role` ไว้ชั่วคราว** (เปลี่ยนเป็น nullable) แทนการลบทันที เพราะ ops-api ทั้งชุดยังเขียน / อ่าน `role` · trigger เติม `roles` ให้เมื่อเขียนมาแค่ `role` (admin → owner) จึงไม่ต้องแก้ ops-api ในงานนี้ · **คำขอถึง O01:** ย้ายโค้ดไปใช้ `roles` แล้วขอ migration ลบ `role` และ trigger
- **ชื่อตารางข้อมูลธุรกิจเป็นพหูพจน์** ตามกติกาของ test entities: `signup_attributions`, `workspace_acquisitions`, `cancellation_responses`, `daily_usages`, `infra_costs`, `marketing_costs` · แก้ชื่อใน 05-business-metrics และไฟล์งานที่อ้างถึงแล้ว
- **เพิ่ม entity ใหม่ลง 01-entities** (หมวด M, N และหมวดใหม่ O) เพราะ test อ่านรายชื่อตารางจากสเปก · ไฟล์นี้เป็นของ D99 จึงบันทึกไว้ที่นี่
- `support_tickets.workspace_id` เป็น null ได้ (อีเมลจากคนที่ยังไม่รู้ว่าเป็นลูกค้าไหน) · `support_sessions.ticket_id` ผูกด้วย FK แบบรวม `workspace_id` ตามกติกา tenant
- `product_events` ยังไม่แบ่ง partition (แบบเดียวกับ `audit_logs`) · แบ่งเมื่อข้อมูลโต
- ค่าที่อนุญาตของตารางใหม่ใช้ `text` + CHECK แทน enum เพื่อเพิ่มค่าได้โดยไม่ต้อง `ALTER TYPE`

### สิทธิ์ของแอปลูกค้า (`friday_app`)

| ตาราง | สิทธิ์ |
|---|---|
| `product_events`, `subscription_changes`, `cancellation_responses` | อ่าน / เขียนเฉพาะ Workspace ปัจจุบัน · แก้ / ลบไม่ได้ |
| `credit_notes`, `workspace_credits` | อ่านของ Workspace ตัวเอง · เขียนไม่ได้ |
| `incidents` (ที่ไม่ใช่ internal), `incident_updates`, `maintenance_windows` | อ่านอย่างเดียว |
| ตารางอื่นทั้งหมดของงานนี้ | ไม่มีสิทธิ์ (`ops_only`) · Ticket ที่ลูกค้าส่งจากแอปให้ API เขียนผ่าน SYSTEM_DB |

### ทดสอบ

- `packages/db` 139 ข้อผ่าน (เพิ่ม `test/ops-phase1.test.ts` 25 ข้อ · `migrations.test.ts` นับตาราง 106 → 127)
- ops-api 20 ข้อผ่านโดยไม่แก้โค้ด (ยังเขียน `role` แบบเดิม) · API ฝั่งลูกค้า 613 ข้อผ่าน · `pnpm typecheck` ผ่าน
- migrate ฐาน QA `friday_canvas_qa` (มีข้อมูล) ผ่าน: staff `admin` ได้ `roles = {owner}` · ตาราง 106 → 127 · เว็บ Docker :3000 และ API :3001 ล็อกอินและโหลดโปรเจกต์ได้ปกติ

