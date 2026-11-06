# W11 · Files

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A11 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/w/[ws]/p/[key]/files/**` · `apps/web/messages/th/files.json` |
| หน้าจอ | 8 (`design/canvas/Files.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · 03-api › 3.8 |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- โฟลเดอร์, อัปโหลด (presigned), เวอร์ชัน, แนบลิงก์, ถังขยะ

## เสร็จเมื่อ

- [ ] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [x] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [x] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

### หน้าที่เพิ่ม

- `app/w/[ws]/p/[key]/files/page.tsx` (server) → `_components/files-page.tsx` (client) + `files.module.css` + `types.ts` · ข้อความ `messages/th/files.json` (namespace `files`)
- แถบซ้าย: รากของโปรเจกต์ + ต้นไม้โฟลเดอร์ (ซ้อนได้ เยื้องตามระดับ) พร้อมจำนวนไฟล์ · `+ New folder` · ขนาดรวม · Trash พร้อมจำนวน
- กล่องลากวาง / เลือกไฟล์ (หลายไฟล์) · แถบความคืบหน้าต่อไฟล์ พร้อมยกเลิก (XHR abort) และข้อความเมื่อล้มเหลว · ไฟล์เกิน 100 MB ไม่ส่ง
- รายการแบบ List (คอลัมน์ตาม Canvas: ชื่อไฟล์ · ผูกกับ · ผู้อัปโหลด · แก้ไขล่าสุด · ขนาด · Ver.) และ Grid · ค้นหาชื่อ (ทั้งโปรเจกต์) · กรองผู้อัปโหลด · เรียง 4 แบบ · breadcrumb เมื่ออยู่ในโฟลเดอร์ · เปลี่ยนชื่อ / ลบโฟลเดอร์
- รายละเอียดไฟล์: Preview (รูปภาพแสดงจริง อื่น ๆ แสดงป้ายนามสกุล) · Download (`files/:id/download` ผ่าน proxy) / เปิดลิงก์ · Upload new version · Copy link · Rename · Move · Delete · ผูกกับงาน (`+ ผูกกับ Task` ใส่รหัสงาน) / เลิกผูก · Version history ดาวน์โหลดเวอร์ชันเก่าได้
- แนบลิงก์ (Figma / Google Drive / Notion / https อื่น) · ถังขยะ: รายการที่ลบ + กู้คืน · ลบแล้ว toast มี "เลิกทำ" (กู้คืน) สำหรับคนที่มี `project.trash`

### API ที่ใช้ (A11)

`GET folders` · `POST folders` · `PATCH/DELETE folders/:id` · `GET files?folder=|q=|uploader=|sort=|trashed=true` · `GET files/:id` · `POST files/upload-url` → PUT → `POST files { uploadToken }` หรือ `POST files/:id/versions` · `POST files { linkUrl, name?, folderId }` · `PATCH files/:id` · `DELETE files/:id { confirm }` (409 `file_is_evidence` → Dialog ยืนยันแสดง Bug / ผลทดสอบ แล้วส่ง `confirm: true`) · `POST files/:id/restore` · `POST/DELETE files/:id/attachments` · `GET my-permissions`

### สิทธิ์และสถานะ

- ซ่อนตาม `my-permissions`: `file.upload` (อัปโหลด, แนบลิงก์, โฟลเดอร์, เวอร์ชันใหม่, Rename, Move, ผูก/เลิกผูก) · `file.delete` (Delete) · `project.trash` (Trash, กู้คืน, เลิกทำ) · ไม่มี `project.trash` จะไม่เรียก `trashed=true` เลย
- กำลังโหลด `LoadingState` · ว่าง `EmptyState` (แยกข้อความ: ว่าง / ไม่พบตามเงื่อนไข / ถังขยะว่าง) · Error `ErrorState` พร้อม requestId · Guest และ 403 → `Forbidden`

### ต่างจาก Canvas / คำตัดสินที่เลือกเอง

- แถบซ้ายของ Canvas มี All files, Recent, From tasks, ตามประเภท และตาม Module · API ของ A11 ไม่มีตัวกรองเหล่านี้ (ไม่ส่ง `folder` = รากเท่านั้น, ไม่มีประเภท/Module) จึงแสดงเฉพาะรากของโปรเจกต์ + โฟลเดอร์จริง · ค้นหาชื่อใช้ `q` ซึ่งค้นทั้งโปรเจกต์แทน "All files"
- กล่อง "พื้นที่ที่ใช้ 1.2 / 10 GB" เปลี่ยนเป็น "ขนาดรวมในมุมมองนี้" (จาก `totalBytes`) เพราะยังไม่มี API โควตาพื้นที่ของ Workspace
- คอลัมน์ "ผูกกับ" แสดงจำนวนที่ผูก + ป้าย "หลักฐาน" (API รายการให้แค่ `attachments` เป็นจำนวน) ส่วนรายชื่องานที่ผูกอยู่ในแผงรายละเอียด
- เรียง "แก้ไขล่าสุด" ใช้ `newest` ของ API (เรียงตามวันที่สร้างไฟล์) จึงตั้งชื่อว่า "อัปโหลดล่าสุด"
- Preview ในหน้าแสดงจริงเฉพาะรูปภาพ · PDF / เอกสาร / Figma embed ยังไม่ทำ
- ลบไฟล์ไม่มี Dialog ก่อนลบ (เป็น soft delete + toast เลิกทำ) ยกเว้นไฟล์หลักฐานที่ API ตอบ 409 ซึ่งต้องยืนยันอีกครั้ง
- Copy link คัดลอก URL ดาวน์โหลด (ต้องเข้าสู่ระบบ) หรือ URL ภายนอกของไฟล์ลิงก์
- ที่เก็บในเครื่อง (dev) API ออก URL อัปโหลดเป็น origin ของ API (`API_PUBLIC_URL` / พอร์ต 3001) ซึ่งไม่เปิด CORS · หน้าเว็บเปลี่ยน path `/api/v1/storage/*` ให้วิ่งผ่าน proxy `/api/v1` ของเว็บเอง (`uploadUrl()`) · S3 ใช้ URL ตามที่ได้
- รายการผู้อัปโหลดในตัวกรองสะสมจากไฟล์ที่เคยโหลด (ไม่มี endpoint รายชื่อผู้อัปโหลด)

### คำขอนอก lane

- **A11**: (ไม่บังคับ) ให้ `GET files` รองรับ "ทุกไฟล์ในโปรเจกต์" โดยไม่ต้องมี `q` และตัวกรองตามประเภท / Module / "From tasks" เพื่อทำแถบซ้ายให้ครบตาม Canvas · endpoint โควตาพื้นที่ (ใช้ / ทั้งหมด) สำหรับกล่องพื้นที่ที่ใช้
- **I01 / deploy**: ตามที่ A11 บันทึกไว้ ต้องตั้ง CORS ของ bucket ให้ origin ของเว็บ PUT ได้ (header `content-type`)

### คำถามที่ค้าง

- ยังไม่ได้ทดสอบอัปโหลดไฟล์ใหญ่ผ่าน proxy rewrites ของ Next ใน dev จริง (ที่เก็บในเครื่องเท่านั้น · production ใช้ S3 ตรง)

### ผล test

- `src/lib/files.test.tsx` 10 ข้อ (MSW): helper (ขนาด, ป้ายนามสกุล, ต้นไม้โฟลเดอร์, `uploadUrl`) · รายการ + รายละเอียด + เวอร์ชัน + งานที่ผูก + Grid + ค้นหา / เรียง / ผู้อัปโหลดส่ง query · อัปโหลด 3 ขั้นจากปุ่มและลากวาง + ไฟล์เกิน 100 MB · อัปโหลดล้มเหลว · เวอร์ชันใหม่ · แนบลิงก์ (ปฏิเสธ http) + สร้างโฟลเดอร์ + breadcrumb + ลบโฟลเดอร์ไม่ว่าง · ผูก / เลิกผูก / Rename / Move · ลบหลักฐานต้องยืนยัน + เลิกทำ + ถังขยะกู้คืน · ซ่อนปุ่มเมื่อไม่มีสิทธิ์ · ว่าง / Error requestId / 403 / Guest
- `pnpm --filter @friday/web typecheck`, `test` (157 ข้อ) และ `build` ผ่าน
- ยังไม่ได้เทียบภาพกับ Canvas ที่ 1440/390 px

