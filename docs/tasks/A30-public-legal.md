# A30 · หน้าสาธารณะ: แพ็กเกจและเอกสารกฎหมาย

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | T00 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/public/**` · `apps/api/test/public.e2e.test.ts` |
| หน้าจอ | R1 (`design/canvas/Landing.dc.html`) · R4 (`design/canvas/Legal.dc.html`) |
| สเปก | 03-api › 2 SaaS (R1, R4) · 03-api › 3.1 แถว `me/legal-acceptances` |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `GET public/plans` · `GET public/legal/{type}` (ฉบับล่าสุด) · `POST me/legal-acceptances`

## กติกาที่ต้องตรง

- ไม่ต้องล็อกอิน (`@Public()`) ยกเว้น acceptances

## เสร็จเมื่อ

- [ ] test ครอบคลุมทุกข้อ
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
