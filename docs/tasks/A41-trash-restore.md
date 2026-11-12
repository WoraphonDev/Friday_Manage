# A41 · API: ถังขยะ กู้คืนโปรเจกต์ และลบถาวรตามกำหนด

| | |
|---|---|
| Wave | O-3 (เฟส 1) · อนุมัติหน้าจอแล้ว 12 พ.ย. 2569 |
| รอ merge | O30 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/trash/**` (module ใหม่) · `apps/api/test/trash.e2e.test.ts` · `apps/api/src/issues/issues.service.ts` (เฉพาะ `restoreDeadline` ให้ใช้ trash_days) · `apps/api/src/privacy/lifecycle.service.ts` (ใช้ `purge_after` + อีเมลเตือน) |
| หน้าจอ | `design/proposals/phase3/05-restore-data.html` › Z1–Z5 |
| สเปก | [03-api](../spec/03-api.md) › 3.8 (`p/trash` · `{type}/{id}:restore`) · [04-permissions](../spec/04-permissions.md) (`project.trash`) |

อ่าน [README](README.md) ก่อนเริ่ม · หน้าจอใน `design/proposals/phase3` ผู้ใช้อนุมัติแล้ว (12 พ.ย. 2569) ยึดตามไฟล์นั้น

## ทำอะไร

ของเดิม (ตรวจ 12 พ.ย. 2569): งานลบ / กู้คืนได้ 30 วัน (เขียนตายตัว) · โปรเจกต์ลบได้แต่**กู้คืนไม่ได้** (`POST projects/:key/restore` คือเลิก Archive) · ไฟล์มีถังขยะ · Workspace มีลบ / กู้คืน / ลบถาวร · **ไม่มีงานลบถาวรของงาน โปรเจกต์ และไฟล์**

- `GET w/trash?type=project|issue|file&project&deletedBy&q&cursor` (Owner / Admin ของ Workspace) และ `GET p/trash` (สิทธิ์ `project.trash`) · ตอบเลข ชื่อ ผู้ลบ วันลบ วันลบถาวร จำนวน Sub-task · จัด "ชุด" งานที่คนเดียวกันลบภายใน 2 นาที
- `POST w/trash/project/{id}:restore` (สิทธิ์เท่าการลบโปรเจกต์: Project Owner / Workspace Owner / Admin) · Key ซ้ำตอบ 409 `project_key_taken` พร้อม Key ที่แนะนำ · รับ `newKey` แล้วเพิ่ม alias ให้ลิงก์เดิม · เกินแพ็กเกจตอบ 402 ก่อนกู้ (ไม่กู้บางส่วน)
- `POST w/trash/issue:restore` รับหลายงาน (ชุด) · ใช้ `IssuesService.restore` ที่มีอยู่ทีละงาน · ไฟล์ใช้ `p/files/{id}/restore` เดิม
- `DELETE w/trash/{type}/{id}` ลบถาวรทันที (Owner เท่านั้น · ต้องส่ง `confirm: "ลบถาวร"`) · คืนพื้นที่ไฟล์
- `restoreDeadline` ของงานใช้ `workspace_settings.trash_days` (30 / 90) แทน 30 ตายตัว
- งานเบื้องหลัง `trash.purge` ทุกคืน 04:30: ลบถาวรงาน โปรเจกต์ และไฟล์ที่พ้น trash_days + ลบไฟล์ในที่เก็บ · ใช้ `SYSTEM_DB` เพราะรวมทุก Workspace (เขียนเหตุผลในคอมเมนต์) · Audit ทุกแถวเป็นสรุปต่อ Workspace
- Workspace: ลบถาวรตาม `purge_after` แทน `deleted_at + 30` · อีเมลเตือน Owner 7 วันและ 1 วันก่อนลบถาวร (Z5) · Owner ส่งออกข้อมูล (A31) ได้ระหว่างรอ
- เหตุการณ์ใหม่ต่อท้าย `EventType`: `project.restored_from_trash` · `trash.purged`

## เสร็จเมื่อ

- [ ] ทุก endpoint มี e2e test ด้วยข้อมูลสมมติ: สิทธิ์ (Owner / Admin / Project Admin / สมาชิก / Guest) · Key ซ้ำ · 402 · ชุด · ลบถาวร · งานลบถาวรตามวัน · อีเมลเตือน
- [ ] ทุก query ของลูกค้าผ่าน `TenantDb.run` · error เป็น `AppError` ภาษาไทย · `pnpm typecheck` / `pnpm --filter @friday/api test` ผ่าน
- [ ] build และ deploy Docker API (`compose.api.yml`) ด้วยฐานข้อมูลเดิม แล้วเรียก endpoint จริงผ่าน :3001

## ยังต้องตัดสินใจ

**ผู้ใช้ตัดสินแล้ว (12 พ.ย. 2569): ใช้ตามคำแนะนำทุกข้อ** · ข้อความ "แนะนำ" ด้านล่างคือคำตัดสิน

- **ระยะถังขยะของงาน** ให้ตามค่า "ถังขยะ 30 / 90 วัน" ของ Admin เหมือนไฟล์และโปรเจกต์ (ตอนนี้งานเขียน 30 วันตายตัว) · **แนะนำ:** ใช่ ใช้ค่าเดียวกันทุกชนิด
- **ลบถาวรจากถังขยะ** ให้ Owner ทำเองได้ (Z3) หรือไม่ · **แนะนำ:** ได้ เฉพาะ Owner + พิมพ์ยืนยัน เพราะลูกค้าต้องลบข้อมูลส่วนบุคคลที่ใส่ผิดและคืนพื้นที่ได้ (หน้า PlanLimits บอกลูกค้าไว้แล้ว)
- **ชื่อ endpoint** ใช้รูปแบบ `{type}/{id}:restore` ในสเปก 03-api ใต้ `w/trash` เพื่อไม่ชนกับ `projects/:key/restore` (เลิก Archive) · **แนะนำ:** ตามนี้ และให้ D99 ปรับสเปก

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน -->
