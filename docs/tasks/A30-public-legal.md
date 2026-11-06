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

- [x] test ครอบคลุมทุกข้อ
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

### Endpoint ที่เพิ่ม (`apps/api/src/public/`)

| Method | Path | สิทธิ์ | หมายเหตุ |
|---|---|---|---|
| GET | `public/plans` | สาธารณะ | `Cache-Control: public, max-age=300` · ราคาเป็นสตางค์ ไม่รวม VAT 7% (`vatIncluded: false`) · แต่ละแพ็กเกจ: `seatLimit`, `projectLimit` (null = ไม่จำกัด), `storageGbPerMember`, `priceMonthlySatang`, `priceYearlySatang` (รายปี = 10 เดือน), `guestsFree`, `contactSales`, `features[]` |
| GET | `public/legal?locale=` | สาธารณะ | ฉบับล่าสุดที่มีผลแล้วของแต่ละชนิด (ไม่มี `body`) |
| GET | `public/legal/{type}?locale=th\|en&version=` | สาธารณะ | `type` = `terms` · `privacy` · `dpa` · `cookie` · `subprocessors` · คืน `body` และ `versions[]` (ประวัติ) · ไม่มีเอกสาร 404 `legal_document_not_found` |
| POST | `me/legal-acceptances` `{ documentId \| type+version, locale?, workspace? }` | ล็อกอิน | 201 ครั้งแรก · ซ้ำตอบ `alreadyAccepted: true` พร้อมเวลาเดิม · บันทึก IP · `workspace` = รับทราบในนาม Workspace (ต้องเป็นสมาชิก) นับแยกจากระดับบัญชี |
| GET | `me/legal-acceptances?locale=` | ล็อกอิน | เอกสารล่าสุดของแต่ละชนิด + `accepted`, `acceptedAt` (ใช้ขึ้นแบนเนอร์ "ข้อกำหนดเปลี่ยน" เมื่อมีฉบับใหม่) |

### คำตัดสินที่เลือกเอง

- **ไม่ใส่เนื้อหากฎหมายใน migration/seed**: Canvas ระบุว่าเนื้อหาจริงต้องให้ที่ปรึกษากฎหมายเขียน ตารางจึงว่างจนกว่าทีม Friday ลงเอกสาร (ผ่าน ops หรือ SQL) · ระหว่างนั้น `public/legal/{type}` ตอบ 404 ให้หน้าเว็บแสดงสถานะ "เร็ว ๆ นี้"
- ฉบับที่ `effective_at` ยังอยู่ในอนาคตไม่แสดงและรับทราบไม่ได้
- ราคา/ขีดจำกัดอ่านจากตาราง `plans` ก่อน (ถ้าทีม Friday ตั้ง) แล้วค่อยใช้ค่าตั้งต้นใน `billing/catalog.ts` ของ A29 · **ราคาจริงยังไม่ตกลง** ค่าตั้งต้นเป็นตัวเลขจากหน้า Checkout (ดูบันทึกผล A29)
- ฟีเจอร์ต่อแพ็กเกจ (`features[]`) กำหนดในโค้ดตาม Landing: Free = kanban, table, calendar, แจ้งเตือน In-app/Email · Team ทุกขนาดเท่ากัน = Free + gantt, workload, sprints, reports, import_excel, automation, line_oa, webhooks, git_integration · Enterprise ใช้ชุดเดียวกับ Team
- Cookie consent เก็บในเบราว์เซอร์ ตาม 03-api (ไม่มี endpoint)

### คำขอนอก lane

- **W19**: ใช้ `public/plans` ทำตารางราคาและตัวเลือกขนาดทีม ("ทีมคุณมีกี่คน") · `public/legal/{type}` ทำหน้า R4
- **W01**: ตอนสมัครส่ง `acceptTerms: true` อยู่แล้ว ถ้าต้องการบันทึกการรับทราบเอกสารฉบับจริงให้เรียก `POST me/legal-acceptances` ต่อหลังสมัคร (A13 ไม่ได้บันทึกให้)

### ผล test

`apps/api/test/public.e2e.test.ts` 8 ข้อ: plans (ไม่ต้องล็อกอิน, ขีดจำกัด/ราคา/ฟีเจอร์ครบ 5 แพ็กเกจ, ค่าใน `plans` ชนะค่าตั้งต้น) · legal (ยังไม่มี 404, ชนิดผิด 400, ฉบับล่าสุดไม่เอาฉบับอนาคต + ประวัติ, ภาษา/เวอร์ชัน, index ไม่มี body) · acceptances (ต้องล็อกอิน, type+version/documentId, ซ้ำ, IP, ฉบับใหม่ต้องรับทราบอีก, ในนาม Workspace, ข้อมูลผิด) · `pnpm typecheck` ผ่าน
