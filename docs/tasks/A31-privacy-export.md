# A31 · PDPA, Export ข้อมูล Workspace, สิทธิ์ทีม Friday, ลบ Workspace

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | T00, A16, A29 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/privacy/**` · `apps/api/test/privacy.e2e.test.ts` |
| หน้าจอ | N1 (`design/canvas/AdminConsole.dc.html`) |
| สเปก | 03-api › 3.3 แถว exports, data-requests, support-access, `DELETE w/` |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `POST / GET w/exports` (202 → คิว → ไฟล์ zip JSON / CSV)
- `GET / PATCH w/data-requests` · `{id}:complete`
- `GET / PUT w/support-access` + Audit
- `DELETE w/` (Owner, ต้องยกเลิกแพ็กเกจก่อน, กู้คืนได้ 30 วัน)

## เสร็จเมื่อ

- [ ] test ครอบคลุมทุกข้อ
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
