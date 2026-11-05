# A27 · เชื่อม GitHub: Commit / PR กับงาน

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | T00 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/git/**` · `apps/api/test/git.e2e.test.ts` · route `hooks/github*`, `w/integrations/git*`, `p/repositories`, `i/git` |
| หน้าจอ | C (`design/canvas/TaskDetail.dc.html`) · L2 (`design/canvas/ProjectSettings.dc.html`) · N1 (`design/canvas/AdminConsole.dc.html`) |
| สเปก | 03-api › 3.3 แถว integrations/git · 03-api › 3.5 แถว `p/repositories` · 03-api › 3.11 `/hooks/github` |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- ติดตั้ง GitHub App → `hooks/github/setup` · `GET / DELETE w/integrations/git`
- `POST hooks/github` (ตรวจลายเซ็น): ผูก Commit / PR จาก Issue key ใน branch, message, title · ย้ายสถานะตามกฎ `p/repositories` · CI ล้มเหลว → Event ให้ A23
- `CRUD p/repositories` · `GET i/git`

## เสร็จเมื่อ

- [ ] test ด้วย payload ตัวอย่างของ GitHub (ข้อมูลสมมติ)
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- GitLab

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
