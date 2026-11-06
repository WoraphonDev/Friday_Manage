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

- [x] test ใช้ที่เก็บในเครื่อง: อัปโหลด → แนบกับงาน → เวอร์ชัน 2 → ลบหลักฐานต้องยืนยัน → กู้คืน
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- ค้นหาข้อความในไฟล์

## บันทึกผล

### Endpoint ที่เพิ่ม (`apps/api/src/files/`) · ทุก route อยู่ใต้ `w/:ws/projects/:key` · Guest → 403 `guest_view_limited`

| Method | Path | สิทธิ์ | หมายเหตุ |
|---|---|---|---|
| GET | `files?folder=&uploader=&q=&sort=&target=&trashed=` | `project.view` | `folder` ไม่ส่ง / `root` = รากของโปรเจกต์ · `q` หรือ `target` ค้นทั้งโปรเจกต์ · `sort` = newest · oldest · name · size · `target=issue:DP-39` / `test_run:<uuid>` = ไฟล์ที่แนบกับงาน/ผลทดสอบนั้น (หน้า C, D) · `trashed=true` ต้องมี `project.trash` · คืน `breadcrumb`, `totalBytes` |
| POST | `files/upload-url` (และ `files:upload-url`) | `file.upload` | `{ name, size, mime?, folderId?, fileId? }` → `{ method: 'PUT', url, headers, uploadToken, expiresAt, maxBytes, storage }` · `fileId` = ขอ URL สำหรับเวอร์ชันใหม่ · เกิน 100 MB → 413 `file_too_large` · พื้นที่เต็ม → 402 (`PlanLimits.assert 'storage_bytes'`) |
| POST | `files` | `file.upload` | `{ uploadToken, note? }` ยืนยันไฟล์ที่ PUT เสร็จแล้ว หรือ `{ linkUrl, name?, folderId? }` แนบลิงก์ (https เท่านั้น · ตรวจ Figma / Google Drive / Notion อื่น ๆ = `other`) |
| GET | `files/:id` | `project.view` | + `versions[]` (ใหม่ก่อน) และ `attachmentList[]` |
| POST | `files/:id/versions` | `file.upload` | `{ uploadToken, note? }` เวอร์ชัน + 1 (ล็อกกันซ้ำ) · ชื่อไฟล์คงเดิม |
| PATCH | `files/:id` | `file.upload` | `name`, `folderId` (null = ราก) |
| DELETE | `files/:id` (body `{ confirm }` หรือ `?confirm=true`) | `file.delete` | soft delete · หลักฐานของผลทดสอบ / Bug ต้อง `confirm: true` ไม่งั้น 409 `file_is_evidence` พร้อม `details.evidence[]` · คืน `restorableUntil` (ตาม `workspace_settings.trash_days` ค่าเริ่มต้น 30 วัน) |
| POST | `files/:id/restore` (และ `:restore`) | `project.trash` (Admin) | เลยกำหนด → 410 `restore_expired` · โฟลเดอร์เดิมหายไปแล้วกลับที่ราก |
| GET | `files/:id/download?version=` | `project.view` | 302 ไป URL ที่หมดอายุใน 5 นาที · ไฟล์ลิงก์ → 400 `link_file` |
| POST / DELETE | `files/:id/attachments` `{ targetType, target? }` | `file.upload` | `targetType` = issue (`target` = Issue key) · test_run (uuid) · comment (uuid) · project (ไม่ต้องมี target) · requirement (code เช่น `FR-9`) · แนบซ้ำไม่ error (`attached: false`) |
| GET / POST | `folders` · PATCH / DELETE `folders/:id` | อ่าน `project.view` · แก้ `file.upload` | ซ้อนได้ · ย้ายเข้าตัวเอง / ลูกหลานตัวเอง → 409 `folder_cycle` · ลบได้เฉพาะโฟลเดอร์ว่าง (รวมไฟล์ในถังขยะ) → 409 `folder_not_empty` |
| PUT | `storage/upload/:token` | token ลงลายมือชื่อ (สาธารณะ) | **ที่เก็บในเครื่องเท่านั้น** (dev / test) รับ byte ของไฟล์ · ขนาดต้องตรงกับที่ประกาศ |
| GET | `storage/download/:token` | token ลงลายมือชื่อ (5 นาที) | **ที่เก็บในเครื่องเท่านั้น** ส่งไฟล์ `Content-Disposition: attachment` + `nosniff` |

### ที่เก็บไฟล์สลับได้ (`storage.ts`)

- ไม่ตั้ง `S3_BUCKET` → `LocalStorage` เก็บใน `config.uploadDir/files/<workspace>/<project>/<uuid>` · ลิงก์ที่ API ออกให้เป็น token ลงลายมือชื่อ (HMAC จาก `AUTH_SECRET`) หมดอายุ 15 นาที (อัปโหลด) / 5 นาที (ดาวน์โหลด) · กัน path traversal ด้วยการบังคับ key ให้อยู่ใต้ root
- ตั้ง `S3_BUCKET` (+ `S3_REGION`, `S3_ENDPOINT` สำหรับ MinIO, ข้อมูลรับรองตามมาตรฐาน AWS SDK) → `S3Storage` ใช้ presigned URL ล้วน (เซิร์ฟเวอร์ไม่แตะไฟล์) · PUT ผูก `Content-Length` และ `Content-Type` ไว้ใน signature จึงอัปโหลดขนาดอื่นไม่ได้ · ยืนยันด้วย `HeadObject`
- เพิ่ม dependency `@aws-sdk/client-s3` และ `@aws-sdk/s3-request-presigner` เวอร์ชัน `3.1156.0` (ล็อกเวอร์ชันที่ออกมานานเกิน 2 สัปดาห์ ตามธรรมเนียมของโปรเจกต์)

### กติกา

- **อัปโหลด 3 ขั้น**: `upload-url` → PUT ไปที่ URL → `POST files` พร้อม `uploadToken` · token ผูกกับ Workspace + โปรเจกต์ + ผู้ขอ + ขนาดที่แจ้ง (ของคนอื่นใช้ไม่ได้, เวอร์ชันกับไฟล์ใหม่ใช้ token สลับกันไม่ได้) · ยืนยันตรวจว่าไฟล์อยู่ในที่เก็บและขนาดตรง ไม่งั้น 409 `upload_incomplete`
- **หลักฐาน** = ไฟล์ที่แนบกับผลทดสอบ หรือกับงานชนิด Bug (Canvas P3 ระดับ 2)
- ทุกการเปลี่ยนแปลงเขียน Audit (`file.uploaded`, `file.version_added`, `file.link_added`, `file.updated`, `file.deleted`, `file.restored`, `file.attached`, `file.detached`)

### การแก้นอก lane ที่ประสานแล้ว

- `auth/auth.guard.ts`: ข้าม CSRF เพิ่มสำหรับ path ขึ้นต้น `/api/v1/storage/` (เหมือน `/hooks/` ที่เพิ่มไว้ใน A24) เพราะ PUT/GET ที่เก็บในเครื่องยืนยันตัวด้วย token ใน URL ไม่มีคุกกี้ session

### คำตัดสินที่เลือกเอง

- ไฟล์ลิงก์รับ https เท่านั้น (ผู้ให้บริการที่ไม่รู้จัก = `other`) ไม่จำกัดเฉพาะ 3 ค่ายในสเปก เพราะเอกสารอ้างอิงจริงมักมีค่ายอื่นด้วย
- ลบ = soft delete เท่านั้น: **ยังไม่มีงานล้างถาวรหลังครบ 30 วัน** (ตัวไฟล์ใน storage และแถวค้างอยู่) ต้องมี Job ตามเวลาในงานถัดไป (A16 ให้ `Jobs.every` แล้ว) ผมไม่เพิ่มเพราะทำลายข้อมูลถาวรควรผ่านการตัดสินใจเรื่อง retention ก่อน
- ถังขยะของโปรเจกต์ใช้ `files?trashed=true` + `files/:id/restore` ส่วนถังขยะรวมงานและไฟล์ (`GET p/trash`, `POST {type}/{id}:restore` ตาม 03-api) ยังไม่ทำ เพราะ `p/trash` ต้องรวมงานที่ลบของ A03 ด้วย
- ไม่มีสแกนไวรัสและไม่ตรวจชนิดไฟล์จากเนื้อหา · ที่เก็บในเครื่องส่ง `nosniff` + `attachment` เสมอเพื่อไม่ให้เบราว์เซอร์รันไฟล์ที่อัปโหลด

### คำขอนอก lane

- **I01 / deploy**: ตั้ง `S3_BUCKET`, `S3_REGION` และ CORS ของ bucket ให้เว็บ PUT ได้ (method PUT, header `content-type`) · ลบ route `storage/*` ออกจากการเปิดสู่สาธารณะถ้าใช้ S3 ล้วน
- **A03**: `GET p/delete-impact` ของงานควรนับไฟล์แนบ (`file_attachments`) ตามที่ P3 แสดง ("ไฟล์แนบ 2 ไฟล์") — A03 อ่านตารางนี้อยู่แล้ว
- **W11 / W02**: อัปโหลดใช้ลำดับ 3 ขั้นข้างบน · แสดงแถบความคืบหน้าจาก XHR ไปที่ `url` ที่ได้ · ขอบเขตแนบกับงานใช้ `POST files/:id/attachments`

### ผล test

`apps/api/test/files.e2e.test.ts` 14 ข้อ (ที่เก็บในเครื่อง): อัปโหลดครบ 3 ขั้น + ดาวน์โหลดจริงตรวจเนื้อหาและ header · ขนาดเกิน 100 MB / ส่งไม่ครบ / เกิน / token ปลอม / ของคนอื่น · เวอร์ชัน 2 (ดาวน์โหลดย้อนหลัง, token สลับไม่ได้) · พื้นที่เต็ม 402 · ลิงก์ภายนอก (Figma / Drive / Notion / other, ปฏิเสธ http) · โฟลเดอร์ (ซ้อน, ย้าย, breadcrumb, วนเป็นวง, ไม่ว่าง) · ค้นหา / กรอง / เรียง · ไฟล์แนบทุกชนิด · **ลบหลักฐานต้องยืนยัน** (ผลทดสอบ, Bug) · ถังขยะ + กู้คืน + เลยกำหนด · สิทธิ์ (Viewer, Guest, คนนอก, ข้ามโปรเจกต์) · S3 presign ไม่ยิงเครือข่าย · `pnpm typecheck` ผ่าน · API ทั้งชุด 406 ผ่าน
