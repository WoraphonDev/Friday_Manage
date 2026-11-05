# A40 · OpenAPI ของทุก endpoint

| | |
|---|---|
| Wave | 3 · ปิดท้าย |
| รอ merge | ทุกงาน A |
| Lane (แก้ได้เฉพาะ) | ทุก controller ใน `apps/api/src/**` (ทำตอนไม่มีงาน API อื่นเปิดอยู่) |
| หน้าจอ | — |
| สเปก | 03-api › 3 (ส่วนที่บอกว่ารายละเอียดได้จาก OpenAPI) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- สร้าง OpenAPI 3.1 จาก zod schema ที่ใช้ `parse()` อยู่แล้ว · `GET /api/v1/openapi.json` (เฉพาะ dev) และไฟล์ `apps/api/openapi.json`
- test ที่ตรวจว่าทุก route มีเอกสาร

## กติกาที่ต้องตรง

- ไม่เปลี่ยนพฤติกรรมของ endpoint

## เสร็จเมื่อ

- [ ] test ผ่าน · ไฟล์ OpenAPI เปิดใน Swagger UI ได้
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
