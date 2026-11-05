# A04 · ข้อมูลโปรเจกต์, สมาชิกโปรเจกต์, Archive / โอน / ลบ, Template

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | T00 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/projects/**` · `apps/api/test/projects.e2e.test.ts` · `apps/api/src/projects/**` (รวม `permissions.ts`, `calendar.ts`, `projects.service.ts` ที่งานอื่นใช้: signature เดิมห้ามเปลี่ยน) |
| หน้าจอ | L2 (`design/canvas/ProjectSettings.dc.html`) · A (`design/canvas/NewProject.dc.html`) · 7 (`design/canvas/Members.dc.html`) · M1 (`design/canvas/States.dc.html`) · P3 (`design/canvas/ConfirmDialogs.dc.html`) |
| สเปก | 03-api › 3.4 และ 3.5 แถว `p/members` · 04-permissions › 3, 6 |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `PATCH p/` (ชื่อ, ลูกค้า, วันที่, visibility, Size → MD ของโปรเจกต์, Key) · เปลี่ยน Key → เก็บ `project_key_aliases` · Key เก่าตอบ 301 `project_moved` พร้อม `details.key`
- `GET / POST / PATCH / DELETE p/members` (Role, ตำแหน่ง, capacity) · ลบคนที่มีงานค้างต้องส่ง `reassignTo`
- `POST p/archive` · `/restore` (Archive = อ่านอย่างเดียว: ตัดสิทธิ์เขียนใน `projectAccess`) · `POST p/transfer` (Project Owner) · `DELETE p/` (`confirmKey`, soft delete 30 วัน) · `GET p/delete-impact`
- `POST w/projects` รับ `templateId` · `POST w/projects/sample` (ข้อมูลสมมติเท่านั้น) · CRUD template อยู่ใน A18

## กติกาที่ต้องตรง

- ทุก endpoint ที่ใช้ `ProjectsService.load` ต้องได้ 301 สำหรับ Key เก่าโดยไม่ต้องแก้ lane อื่น

## เสร็จเมื่อ

- [ ] test ครอบคลุมทุกข้อ
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
