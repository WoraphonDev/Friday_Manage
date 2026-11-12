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

- [x] ทุก endpoint มี e2e test ด้วยข้อมูลสมมติ: สิทธิ์ (Owner / Admin / Project Admin / สมาชิก / Guest) · Key ซ้ำ · 402 · ชุด · ลบถาวร · งานลบถาวรตามวัน · อีเมลเตือน
- [x] ทุก query ของลูกค้าผ่าน `TenantDb.run` · error เป็น `AppError` ภาษาไทย · `pnpm typecheck` / `pnpm --filter @friday/api test` ผ่าน
- [ ] build และ deploy Docker API (`compose.api.yml`) ด้วยฐานข้อมูลเดิม แล้วเรียก endpoint จริงผ่าน :3001

## ยังต้องตัดสินใจ

**ผู้ใช้ตัดสินแล้ว (12 พ.ย. 2569): ใช้ตามคำแนะนำทุกข้อ** · ข้อความ "แนะนำ" ด้านล่างคือคำตัดสิน

- **ระยะถังขยะของงาน** ให้ตามค่า "ถังขยะ 30 / 90 วัน" ของ Admin เหมือนไฟล์และโปรเจกต์ (ตอนนี้งานเขียน 30 วันตายตัว) · **แนะนำ:** ใช่ ใช้ค่าเดียวกันทุกชนิด
- **ลบถาวรจากถังขยะ** ให้ Owner ทำเองได้ (Z3) หรือไม่ · **แนะนำ:** ได้ เฉพาะ Owner + พิมพ์ยืนยัน เพราะลูกค้าต้องลบข้อมูลส่วนบุคคลที่ใส่ผิดและคืนพื้นที่ได้ (หน้า PlanLimits บอกลูกค้าไว้แล้ว)
- **ชื่อ endpoint** ใช้รูปแบบ `{type}/{id}:restore` ในสเปก 03-api ใต้ `w/trash` เพื่อไม่ชนกับ `projects/:key/restore` (เลิก Archive) · **แนะนำ:** ตามนี้ และให้ D99 ปรับสเปก

## บันทึกผล

ส่งงาน 12 พ.ย. 2569 · module ใหม่ `apps/api/src/trash` · ไม่มี migration (ใช้คอลัมน์ / trigger / ดัชนีของ O30)

**Endpoint** (ทุกตัวอยู่ใต้ `w/:ws` ยกเว้นหน้า Workspace ที่ลบ)
- `GET w/trash?type=project|issue|file&project&deletedBy&q&cursor&limit` (Owner / Admin) · `GET w/projects/:key/trash?type=issue|file…` (สิทธิ์ `project.trash` · Guest ไม่ได้) · ตอบ `items` (เลข ชื่อ โปรเจกต์ ผู้ลบพร้อมบทบาท วันลบ `purgeAt` `daysLeft` จำนวน Sub-task · โปรเจกต์มี `counts` และ `keyTaken` · ไฟล์มีขนาดรวมทุกเวอร์ชันและโฟลเดอร์) · `counts` ต่อแท็บ · `batches` · `deleters` / `projects` สำหรับตัวกรอง · `can.purge` · `nextCursor`
- งานที่แสดง = รากของการลบ: Sub-task ที่ลบพร้อมแม่ไม่แสดงแยก (นับใน `subtasks`) · งาน / ไฟล์ในโปรเจกต์ที่อยู่ในถังขยะไม่แสดงแยก (กลับมาพร้อมโปรเจกต์) · รายการที่พ้นกำหนดแล้ว (รอรอบลบถาวร) ไม่แสดง
- "ชุด" = งานที่คนเดียวกันลบห่างจากงานแรกของชุดไม่เกิน 2 นาที และมี ≥ 2 งาน · คิดจากหน้าที่ตอบ (ค่าเริ่มต้น 100 แถว)
- `POST w/trash/issue:restore` / `file:restore` รับ `{ ids }` · งานใช้ `IssuesService.restore` ทีละงาน (แม่ก่อนลูก) · ส่งรายการเดียวแล้วไม่สำเร็จตอบ error ของรายการนั้น · หลายรายการตอบ `{ restored, failed }`
- `POST w/trash/project/:id:restore` `{ newKey? }` · Key ถูกใช้ตอบ 409 `project_key_taken` + `takenBy` (ชื่อแสดงเฉพาะเมื่อผู้เรียกมองเห็น) + `suggestedKey` (MKT → MKT2) · `newKey` ซ้ำตอบ 409 `key_taken` · เก็บ Key เดิมเป็น alias · เกินแพ็กเกจตอบ 402 ก่อนเขียน (โปรเจกต์ที่ Archive ไม่นับ) · Audit `project.restored_from_trash` (+ `project.key_changed`)
- `DELETE w/trash/:type/:id` `{ confirm: "ลบถาวร" }` และแบบหลายรายการ `POST w/trash/:type:purge` `{ ids, confirm }` (Owner เท่านั้น) · ลบไฟล์ในที่เก็บหลัง commit (local / S3) · Audit `trash.purged` 1 แถวต่อคำขอ
- `GET workspaces/:slug/deleted` (สมาชิก active ทุกคนของ Workspace ที่ลบ · คนอื่น 404) ข้อมูลหน้า Z5: วันลบถาวร ผู้ลบ Owner (ชื่อ + อีเมลให้ติดต่อ) จำนวนโปรเจกต์ / งาน / พื้นที่ / สมาชิก แพ็กเกจ `can.restore` / `can.export`
- `POST / GET workspaces/:slug/deleted/exports` + `…/exports/:id/download` (Owner) ส่งออกข้อมูลระหว่างรอลบถาวร · งาน `trash.export-deleted`
- เหตุการณ์ใหม่: `project.restored_from_trash` · `trash.purged` (`source: user | schedule`)

**งานเบื้องหลัง**
- `trash.purge` ทุกคืน 04:30 (SYSTEM_DB · ทุกคำสั่งกรอง workspace_id เอง): ลบงาน / โปรเจกต์ / ไฟล์ที่พ้น `trash_days` ของแต่ละ Workspace + ไฟล์ในที่เก็บ · ข้าม Workspace ที่ลบแล้ว (ลบทั้งก้อนตาม `purge_after`) · Audit สรุป 1 แถวต่อ Workspace (actor `system`)
- `privacy.purge-workspaces` (04:00 เดิม) เตือนก่อนแล้วลบ: ลบถาวรตาม `purge_after` แทน `deleted_at + 30` · อีเมลเตือน Owner รอบ 7 วันและ 1 วัน (กันส่งซ้ำด้วย `purge_reminded_at` · ข้ามรอบส่งเฉพาะรอบใกล้สุด · ยืดเวลาแล้วรอบเตือนเลื่อนตาม) · Audit `workspace.purge_reminded`

**แก้นอกโฟลเดอร์ trash** (คำขอนอก lane ที่ทำไปเพราะเลี่ยงไม่ได้ · ไฟล์เล็ก)
- `projects.service.ts` (A04): `keyFree()` ไม่นับโปรเจกต์ในถังขยะ (เปิดเป็น public ให้ trash ใช้) · `load()` เลือกแถวที่ยังไม่ลบก่อนเมื่อ Key ซ้ำกับโปรเจกต์ในถังขยะ · `projects.e2e.test.ts` เปลี่ยนความคาดหวังว่า Key ของโปรเจกต์ที่ลบใช้ใหม่ได้แล้ว
- `issues.service.ts` (A03): `restoreDeadline` ใช้ `trash_days` · `restore(…, { workspaceAdmin })` ให้ Owner / Admin ของ Workspace กู้จากถังขยะได้แม้ไม่มี `issue.delete` ในโปรเจกต์ (RLS ยังกรองงานที่มองไม่เห็น)
- `line.sender.ts`: หาคำขอเลื่อน Due ด้วย Key กรองโปรเจกต์ที่ลบแล้ว (Key ซ้ำได้)
- `privacy/build-export.ts` (A31): ทุกตารางระดับ Workspace กรอง workspace_id เอง เพื่อ Export Workspace ที่ลบแล้วผ่าน SYSTEM_DB ได้ · โฟลเดอร์ของโปรเจกต์ในถังขยะใน zip แยกชื่อ (Key อาจซ้ำ)
- `privacy.e2e.test.ts`: test ลบถาวรตั้ง `purge_after` ด้วย (trigger ไม่ทับค่าของแถวที่ลบอยู่แล้ว)
- ไฟล์กลาง: ลงทะเบียน `TrashModule` ใน `app.module.ts` · เพิ่ม Event 2 ตัวท้าย `EventType` · `openapi.json` สร้างใหม่

**ตัดสินใจระหว่างทำ**
- Owner / Admin ของ Workspace เห็นงานและไฟล์ในถังขยะเฉพาะโปรเจกต์ที่มองเห็นตาม RLS (โปรเจกต์ Private ที่ยังไม่ได้เข้าร่วมเห็นแค่แถวโปรเจกต์ · เข้าร่วมในฐานะ Admin ก่อน) · จำนวนงาน / ไฟล์ / สมาชิกของโปรเจกต์ในถังขยะนับผ่าน SYSTEM_DB (ตัวเลขอย่างเดียว) เพื่อให้ Z2 บอก "สิ่งที่กลับมา" ได้ครบ
- กู้ไฟล์ทำใน trash เอง (ไม่เรียก `p/files/{id}/restore`) เพราะเส้นทางเดิมต้องเป็นสมาชิกที่มี `project.trash` · กติกาเดียวกัน (โฟลเดอร์หายกลับไปที่ราก)
- alias ของ Key เดิมตอนกู้คืนด้วย Key ใหม่เขียนด้วย SYSTEM_DB หลัง commit เพราะ Admin ของ Workspace ที่ยังไม่ได้เข้าร่วมโปรเจกต์ Private เขียนตารางในโปรเจกต์ผ่าน RLS ไม่ได้
- ลบงานถาวรไม่ลบไฟล์ที่เคยแนบ (ไฟล์เป็นของโปรเจกต์และอาจแนบหลายที่) · ลบไฟล์ถาวรคืนพื้นที่ทุกเวอร์ชัน
- Export ระหว่างรอลบ: RLS ซ่อน Workspace ที่ลบ จึงสร้าง zip ด้วย SYSTEM_DB หลังทำให้ `buildWorkspaceZip` กรอง workspace_id ทุกตาราง · ใช้ตาราง / ที่เก็บไฟล์เดียวกับ A31 (`privacy.cleanup-exports` ลบไฟล์หมดอายุให้)

**ตรวจแล้ว:** `apps/api/test/trash.e2e.test.ts` 17 ข้อ · `pnpm --filter @friday/api test` · `pnpm typecheck` ผ่าน (ฐาน `friday_s_restore`) · ยังไม่ได้ build / deploy Docker (ผู้ประสานงานทำต่อ)
