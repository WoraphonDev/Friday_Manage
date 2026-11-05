# A28 · API token (Bearer)

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | T00, A13 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/auth/**` · `apps/api/test/api-tokens.e2e.test.ts` |
| หน้าจอ | N1 (`design/canvas/AdminConsole.dc.html`) |
| สเปก | 03-api › 1 การยืนยันตัวตน · 03-api › 3.3 แถว `w/api-tokens` · 04-permissions › 5 ข้อ 9 |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `CRUD w/api-tokens` (แสดง token เต็มครั้งเดียว, เก็บ hash, scopes)
- `Authorization: Bearer` ใน `auth.guard.ts`: สิทธิ์ = สิทธิ์ของผู้สร้าง ∩ scopes · ไม่ต้องใช้ CSRF

## กติกาที่ต้องตรง

- ทำหลัง A13 merge (lane เดียวกัน)

## เสร็จเมื่อ

- [ ] test: token อ่านได้แต่เขียนไม่ได้ตาม scope, token ที่ยกเลิกแล้วได้ 401
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
