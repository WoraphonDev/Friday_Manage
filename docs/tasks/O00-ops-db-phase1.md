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
- ข้อมูลธุรกิจตาม 05 › 1: `signup_attribution`, `workspace_acquisition`, `product_events` (partition รายเดือน), `subscription_changes`, `cancellation_feedback`, `usage_daily`, `cost_rates`, `infra_cost_monthly`, `marketing_spend`
- RLS: ตารางที่มี `workspace_id` เปิด RLS ตามธรรมเนียม · ตารางระดับระบบให้สิทธิ์เฉพาะบัญชี ops

## เสร็จเมื่อ

- [ ] migration ใหม่ต่อจาก 0016 รันซ้ำได้บนฐานข้อมูลที่มีข้อมูล (ห้ามล้าง)
- [ ] test RLS ของตารางใหม่ผ่าน · constraint `support_sessions_write_approval` คงไว้
- [ ] `pnpm db:migrate` บนฐานข้อมูลทดสอบเดิมผ่าน · `pnpm typecheck` และ `pnpm test` ผ่าน

## ไม่อยู่ในงานนี้

- endpoint และหน้าจอ (O01–O06, O10–O15)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
