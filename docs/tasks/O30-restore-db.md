# O30 · ตารางของการกู้คืนข้อมูล: วันลบถาวรที่ยืดได้ และดัชนีถังขยะ

| | |
|---|---|
| Wave | O-3 (เฟส 1) · อนุมัติหน้าจอแล้ว 12 พ.ย. 2569 |
| รอ merge | — |
| Lane (แก้ได้เฉพาะ) | `packages/db/**` |
| หน้าจอ | `design/proposals/phase3/05-restore-data.html` (Z1–Z9, บอร์ด 21) |
| สเปก | [01-entities](../spec/01-entities.md) (ข้อ "ลบ" · ถังขยะ 30 วัน) · [03-api](../spec/03-api.md) › 3.8 `p/trash` |

อ่าน [README](README.md) ก่อนเริ่ม · หน้าจอใน `design/proposals/phase3` ผู้ใช้อนุมัติแล้ว (12 พ.ย. 2569) ยึดตามไฟล์นั้น

## ทำอะไร

- `workspaces.purge_after` (timestamptz, null ได้) · ตอนลบ Workspace ตั้งเป็น `deleted_at + 30 วัน` · ย้ายข้อมูลเดิม: แถวที่ `deleted_at` ไม่ว่างตั้งค่าเป็น `deleted_at + 30 วัน` · ทีม Friday ยืดได้ (Z7)
- ดัชนีบางส่วน `WHERE deleted_at IS NOT NULL` ของ `issues`, `projects`, `files` (workspace_id, deleted_at) ให้หน้าถังขยะและงานลบถาวรไม่ต้องอ่านทั้งตาราง
- `project_key_aliases` ใช้ได้กับการกู้คืนโปรเจกต์ที่ต้องเปลี่ยน Key (Z2) อยู่แล้ว · ตรวจว่าไม่ต้องแก้
- RLS: แถวที่อยู่ในถังขยะยังอ่านได้เฉพาะผู้มีสิทธิ์ตามเดิม · ไม่เพิ่มสิทธิ์ใหม่ให้ `friday_app`
- ไม่ต้องมีตารางคำขอกู้คืน: การกู้แทนลูกค้าของทีม Friday บันทึกใน `staff_audit_logs` + `audit_logs` ของลูกค้า

## เสร็จเมื่อ

- [x] migration ใหม่ + snapshot ของ drizzle · `pnpm db:migrate` บนฐานที่มีข้อมูลทดสอบเดิมผ่าน (ไม่ล้างข้อมูล)
- [x] test ของ `packages/db` ครอบคลุมค่าย้ายข้อมูลและดัชนี · `pnpm typecheck` / `pnpm test` ผ่าน
- [ ] build และ deploy Docker API ในเครื่องตาม CLAUDE.md (ใช้ฐานข้อมูลเดิม) แล้วตรวจว่า API เดิมยังทำงาน

## ยังต้องตัดสินใจ

**ผู้ใช้ตัดสินแล้ว (12 พ.ย. 2569): ใช้ตามคำแนะนำทุกข้อ** · ข้อความ "แนะนำ" ด้านล่างคือคำตัดสิน

- ไม่มี (คำถามเรื่องระยะเวลาอยู่ใน A41 และ O31)

## บันทึกผล

ส่งงาน 12 พ.ย. 2569 · migration `0032_restore_trash` (รวม PR เดียวกับ O32)

**คอลัมน์ใหม่**
- `workspaces.deleted_by` (ผู้ลบ) · `purge_after` (วันลบถาวร) · `purge_reminded_at` (อีเมลเตือนล่าสุด) · CHECK `purge_after` มีค่าได้เฉพาะ Workspace ที่ลบแล้ว
- `projects.deleted_by` · `issues.deleted_by` · `files.deleted_by` (FK `users` ON DELETE SET NULL)

**ตั้งค่าในฐานข้อมูล (trigger `soft_delete`)** เพื่อให้ทุกทางที่ลบ (API ลูกค้า, นำเข้า Excel, ops-api) ได้ค่าเดียวกันโดยไม่ต้องแก้ service ที่อยู่นอก lane
- `app.track_soft_delete()` บน projects / issues / files: ตอน `deleted_at` เปลี่ยนจากว่างเป็นมีค่า ตั้ง `deleted_by` = ค่าที่ API ส่งมา หรือ `app.user_id` ของธุรกรรม · กู้คืน (`deleted_at` = null) ล้าง `deleted_by`
- `app.workspace_soft_delete()` บน workspaces: เหมือนข้างบน + ตั้ง `purge_after = deleted_at + 30 วัน` ถ้าไม่ได้ส่งมา · กู้คืนแล้วล้าง `deleted_by`, `purge_after`, `purge_reminded_at` · ยืดเวลา (O31) = UPDATE `purge_after` ตรง ๆ trigger ไม่ทับ
- ยืดไปแล้วกี่วันคำนวณได้จาก `purge_after − (deleted_at + 30 วัน)` จึงไม่มีคอลัมน์แยก (วงเงิน ≤ 30 วันของ O31)
- `purge_reminded_at` ให้ A41 ใช้กันส่งอีเมลเตือนซ้ำ: ส่งรอบ 7 วันเมื่อ `now ≥ purge_after − 7 วัน` และ `purge_reminded_at` ว่างหรือก่อนเวลานั้น (รอบ 1 วันเช่นเดียวกัน) · ยืดเวลาแล้วรอบเตือนเลื่อนตามเอง

**ย้ายข้อมูลเดิม** (ปิด trigger touch ชั่วคราว updated_at / version ไม่เปลี่ยน): Workspace ที่ลบแล้วได้ `purge_after = deleted_at + 30 วัน` · `deleted_by` เติมจากประวัติที่มี (งาน = `activities` verb deleted · โปรเจกต์ / ไฟล์ / Workspace = `audit_logs` action `*.deleted`) ถ้าผู้ใช้ยังอยู่

**ดัชนี** `issues_trash_idx`, `projects_trash_idx`, `files_trash_idx` (workspace_id, deleted_at) WHERE deleted_at IS NOT NULL · `workspaces_purge_idx` (purge_after) WHERE deleted_at IS NOT NULL

**`project_key_aliases`** ใช้กับ Z2 ได้โดยไม่ต้องแก้ แต่ `projects_workspace_key_key` เดิมกัน Key ของโปรเจกต์ในถังขยะไว้ จึงเกิดกรณี "Key ซ้ำตอนกู้คืน" ไม่ได้เลย · เปลี่ยนเป็น unique เฉพาะ `deleted_at IS NULL` ตามหน้าจอ Z2 (กู้คืนแล้วชนต้องเลือก Key ใหม่) · **ยังต้องทำนอก lane:** `keyFree()` ใน `apps/api/src/projects/projects.service.ts` ยังนับโปรเจกต์ที่ลบแล้ว (ผ่าน friday_system) ถ้าจะให้โปรเจกต์ใหม่ใช้ Key ของโปรเจกต์ในถังขยะ ต้องกรอง `deleted_at IS NULL` และตรวจที่ค้นโปรเจกต์ด้วย Key ว่ากรองแถวที่ลบแล้ว

**RLS:** ไม่เพิ่มสิทธิ์ให้ `friday_app` · แถวในถังขยะยังผ่าน policy เดิม (test ยืนยันว่าสมาชิกที่ไม่อยู่ในโปรเจกต์และคนนอก Workspace ไม่เห็น) · Workspace ที่ลบแล้วยังมองไม่เห็นจาก friday_app (`app.ws_role` กรอง `deleted_at`) งานกู้คืน / ลบถาวรของ Workspace จึงยังใช้ SYSTEM_DB ตามเดิม

**ตรวจแล้ว:** test ใหม่ใน `packages/db/test/phase3.test.ts` (O30 5 ข้อ) และ `migrations.test.ts` (อัปเกรด 0031 → 0032 ที่มีแถวในถังขยะ) · `pnpm --filter @friday/db test` 163 ผ่าน · `pnpm typecheck` ผ่าน · `@friday/api` 685 ผ่าน (7 ข้าม) · `@friday/ops-api` 162 ผ่าน (1 ข้าม) บนฐาน `friday_p3db` · ยังไม่ได้ build / deploy Docker (ผู้ประสานงานทำต่อ)
