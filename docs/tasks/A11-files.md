# A11 · ไฟล์, โฟลเดอร์, เวอร์ชัน และไฟล์แนบ

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | — เริ่มได้เลย |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/files/**` · `apps/api/test/files.e2e.test.ts` |
| หน้าจอ | 8 (`design/canvas/Files.dc.html`) · C (`design/canvas/TaskDetail.dc.html`) · D (`design/canvas/SubtaskModal.dc.html`) · P3 (`design/canvas/ConfirmDialogs.dc.html`) |
| สเปก | 03-api › 3.8 ไฟล์ · 01-entities › H |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- ที่เก็บไฟล์แบบสลับได้: ในเครื่อง (`config.uploadDir`) ตอน dev / test และ S3 (presigned URL) เมื่อตั้ง env `S3_BUCKET` · เพิ่ม dependency `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`
- ทุก endpoint ในหมวด 3.8: upload-url, ยืนยันไฟล์ / แนบลิงก์ (Figma, Drive, Notion), versions, rename / move, delete (หลักฐานต้อง `confirm: true`), download (redirect URL หมดอายุ 5 นาที), attachments กับงาน / ผลทดสอบ, folders, trash + restore
- เรียก `PlanLimits.assert(tx, ws, "storage_bytes", size)` ก่อนออก upload URL

## กติกาที่ต้องตรง

- ไฟล์ ≤ 100 MB → เกินตอบ 413 `file_too_large`
- ลบไฟล์ = soft delete 30 วัน

## เสร็จเมื่อ

- [ ] test ใช้ที่เก็บในเครื่อง: อัปโหลด → แนบกับงาน → เวอร์ชัน 2 → ลบหลักฐานต้องยืนยัน → กู้คืน
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- ค้นหาข้อความในไฟล์

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
