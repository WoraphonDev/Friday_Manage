# A22 · ค้นหา, การค้นหาที่บันทึก และ View ที่บันทึก

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | T00 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/search/**` · `apps/api/test/search.e2e.test.ts` |
| หน้าจอ | P1 (`design/canvas/Search.dc.html`) · 2 (`design/canvas/Table.dc.html`) |
| สเปก | 03-api › 3.9 แถว `w/search`, `w/saved-searches`, `p/saved-views` |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `GET w/search?q&type&project&limit`: ชื่อ / รายละเอียดงาน, Issue key (`#DP-39`), คอมเมนต์, ชื่อไฟล์, โปรเจกต์, คน (`@ชื่อ`) · ใช้ index trigram จาก T00 · Command palette ใช้ `limit=8`
- `CRUD w/saved-searches` (ของตัวเอง) · `CRUD p/saved-views` (ของตัวเอง หรือแชร์ทั้งโปรเจกต์ด้วย `project.views.share`)

## กติกาที่ต้องตรง

- กรองตามสิทธิ์ก่อนตอบ (RLS + Guest)

## เสร็จเมื่อ

- [ ] test: คำค้นภาษาไทย 3 ตัวอักษร, Guest ไม่เห็นงานที่ไม่ได้แชร์
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- ข้อความในไฟล์

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
