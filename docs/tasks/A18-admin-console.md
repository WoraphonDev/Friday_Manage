# A18 · Admin Console ของ Workspace

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | T00, A05 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/admin/**` · `apps/api/test/admin.e2e.test.ts` |
| หน้าจอ | N1 (`design/canvas/AdminConsole.dc.html`) |
| สเปก | 03-api › 3.3 (แถวที่ไม่ได้ระบุว่าเป็นของงานอื่น) · 03-api › 3.2 แถว `w/teams` |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `GET w/admin/overview` · `GET / PATCH w/settings` · `GET / POST / DELETE w/holiday-calendars`, `w/holidays` (เปลี่ยนแล้วเรียก `recalculatePlanEnds` ของ A05 ทุกโปรเจกต์ที่ใช้ปฏิทินนั้น)
- `CRUD w/project-templates` · `GET / PATCH w/security-policy` · `CRUD w/teams`, `w/teams/{id}/members`
- `GET w/audit-log?category&user&from&to` และ `.csv` (`ws.audit.view`)

## กติกาที่ต้องตรง

- ทุกการแก้เขียน Audit log

## เสร็จเมื่อ

- [ ] test ครอบคลุมทุกข้อ
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- ช่องทางแจ้งเตือน (A24, A25)
- Git (A27)
- API token (A28)
- Billing (A29)
- Export / PDPA / support access (A31)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
