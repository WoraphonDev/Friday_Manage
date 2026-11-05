# A15 · Import Excel โหมดอัปเดตแผน และ Export

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | — เริ่มได้เลย |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/imports/**` · `apps/api/test/imports.e2e.test.ts` |
| หน้าจอ | L3 (`design/canvas/ImportExcel.dc.html`) |
| สเปก | 03-api › 3.6 แถว import-jobs, `p/export.xlsx` · `apps/api/src/imports/*` (โหมดสร้างใหม่ที่มีอยู่) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- โหมด `update` ของโปรเจกต์ที่มีอยู่: จับคู่แถวด้วย `excel_row_no` (คอลัมน์ No.) · ผลตรวจแสดงงานใหม่ / เปลี่ยน (รายฟิลด์) / หายไปจากไฟล์ · commit แก้งาน + เขียน `plan_changes` (source import) · ต้องมี `project.baseline`
- `GET p/export.xlsx` 18 คอลัมน์แบบไฟล์แผนต้นฉบับ (ID, No., Module, Sprint = กลุ่มงาน, …) และชีต Holidays · นำเข้าไฟล์ที่ export กลับมาได้ผลเท่าเดิม
- Event `import.completed`

## กติกาที่ต้องตรง

- งานที่หายไปจากไฟล์ไม่ลบอัตโนมัติ: แสดงในผลตรวจให้เลือก

## เสร็จเมื่อ

- [ ] test: export แล้ว import อัปเดตด้วยไฟล์เดิม = ไม่มีอะไรเปลี่ยน · แก้ Man-Day 1 แถวแล้วได้ plan_change 1 รายการ
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- commit แบบ async + ความคืบหน้า (หลัง A16 / A17)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
