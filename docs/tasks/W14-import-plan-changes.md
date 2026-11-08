# W14 · Import Excel และการแก้ไขแผน

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A07 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/work/[ws]/import/**` · `apps/web/app/work/[ws]/p/[key]/plan-changes/**` · `apps/web/messages/th/import-plan-changes.json` |
| หน้าจอ | L3 (`design/canvas/ImportExcel.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · 03-api › 3.6 แถว import-jobs, plan-changes |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- อัปโหลด → จับคู่คอลัมน์ / คน → ผลตรวจ → นำเข้า (โหมดสร้างใหม่มีแล้ว, โหมดอัปเดตเมื่อ A15 merge)
- แท็บการแก้ไขแผน + Export

## เสร็จเมื่อ

- [x] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [x] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [x] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

### สิ่งที่ทำ

- `w/[ws]/import` (`_components/import-wizard.tsx`): 4 ขั้นตาม Canvas L3
  - อัปโหลด: ลากวาง / เลือกไฟล์ (รับเฉพาะ `.xlsx`), เลือกโหมด "สร้างใหม่" หรือ "อัปเดตโปรเจกต์เดิม" (เลือกโปรเจกต์ได้ · `?project=KEY` เลือกให้และเปิดโหมดอัปเดต) → `POST w/:ws/import-jobs` (multipart: file, mode, projectKey)
  - จับคู่คอลัมน์: ตัวเลือกจาก `fields` ของ job · ฟิลด์ที่คอลัมน์อื่นใช้แล้วซ่อนไว้ · เปลี่ยนแล้ว `PATCH import-jobs/:id {columnMapping}` และแสดงผลตรวจใหม่ทันที
  - ตรวจสอบข้อมูล: KPI 6 ช่องจาก `summary`, chip กรอง มีประเด็น / ต้องแก้ / เตือน, รายการ findings (แสดงทีละ 100), โหมดอัปเดตมีการ์ด "เทียบกับแผนปัจจุบัน" (changed / added / missing) และเลือก เก็บ / ลบ ต่องานหรือทั้งหมด (`missing`, `missingAll`)
  - ยืนยัน: สร้างใหม่ = ชื่อโปรเจกต์ + Project Key, สรุปสิ่งที่จะสร้าง, จับคู่คนกับสมาชิก (`GET w/:ws/members` ไม่รวม Guest) / ไม่ระบุ / เชิญด้วยอีเมล, ตั้ง Baseline v1 · อัปเดต = เหตุผลของการแก้แผน (`planChangeReason`) · ชื่อ / Key / เหตุผลส่ง PATCH ตอนกดนำเข้า แล้ว `POST import-jobs/:id/commit` → หน้าสรุปผลพร้อมลิงก์ Table / การแก้ไขแผน
  - ปุ่มบนหัว: Export Excel (`GET projects/:key/export.xlsx`) และกลับไปที่ Table เมื่อรู้โปรเจกต์ · Guest ของ Workspace เห็น Forbidden · โหมดอัปเดตกดต่อไม่ได้ถ้าไม่มี `project.baseline`
- `w/[ws]/p/[key]/plan-changes` (`_components/plan-changes-view.tsx`): แท็บ "การแก้ไขแผน (Plan vs Baseline)"
  - เทียบ Baseline ล่าสุด (เลือก Baseline อื่นได้) จาก `GET projects/:key/baselines` · รายการจาก `GET plan-changes?baseline=vN&limit=100` พร้อม "โหลดเพิ่ม" ด้วย `before=nextCursor`
  - วันจบ Module แผน vs คาดการณ์ คำนวณจาก `GET gantt?baseline=vN` (วันจบสูงสุดตาม Baseline ของงาน + Sub-task เทียบ `module.end`)
  - คัดลอกรายการที่แก้ไข (clipboard), Export Excel (`plan-changes.xlsx?baseline=vN`), ตั้งเป็น Baseline v(N+1) (`POST baselines`, เฉพาะ `project.baseline`) แล้วสลับไปเทียบกับ Baseline ใหม่
  - ค่า Dev (`assigneeIds`) แปลง userId เป็นชื่อจาก `GET w/:ws/members` · ลิงก์งานใช้ `?issue=KEY`
  - สถานะ: กำลังโหลด, ยังไม่มี Baseline, ยังไม่มีการแก้ไข, Error พร้อม requestId, 403 / Guest = Forbidden
- หัวหน้าที่ใช้ร่วมกัน `import/_components/import-header.tsx` (แท็บสองส่วนเป็นลิงก์ระหว่างสองเส้นทาง)
- Test: `src/lib/import-plan-changes.test.tsx` (9 test: โหมดสร้างใหม่ครบ 4 ขั้น, ไฟล์ไม่ใช่ .xlsx / อัปโหลดซ้ำเมื่อเปลี่ยนไฟล์ / Error requestId, โหมดอัปเดต, สิทธิ์, รายการแก้ไข + โหลดเพิ่ม + คัดลอก + Export, ตั้ง Baseline ใหม่, ไม่มี Baseline, Error / 403 / Guest)

### จุดที่ต่างจาก Canvas และเหตุผล

- Canvas วาง "นำเข้า" กับ "การแก้ไขแผน" เป็นแท็บในหน้าเดียว · เว็บแยกเป็นสองเส้นทางตาม lane จึงทำแท็บเป็นลิงก์ (`/import?project=KEY` ↔ `/p/KEY/plan-changes`) · หน้าการแก้ไขแผนอยู่ใต้ project shell จึงไม่แสดงหัว "Import / Export Excel" ซ้ำ
- ไม่มีปุ่ม "ดาวน์โหลด Template": API ยังไม่มี endpoint template (ดูคำขอนอก lane)
- ไม่มีตัวเลือกชีตในขั้นอัปโหลด: API เลือกชีตตารางงานเอง (ชีตแรกที่มีหัว No. + Module) และไม่รับชื่อชีต · แสดงชื่อชีตที่อ่านได้แทน
- ต้องเลือกโหมดก่อนอัปโหลด (API รับ mode ตอน `POST import-jobs`) · เปลี่ยนไฟล์ / โหมด / โปรเจกต์หลังอัปโหลด = อัปโหลดใหม่และล็อกขั้นถัดไป
- ผลตรวจมีเฉพาะระดับ ต้องแก้ / เตือน (API ไม่มีระดับ "แนะนำ" และไม่ส่งรายการแถวที่พร้อม) · chip "พร้อม" จึงเป็นป้ายจำนวนแทนตัวกรอง และไม่มีคอลัมน์ meta (Size · MD · Dev) ใต้ชื่องาน · แสดง "แถว N ในไฟล์" แทน
- รายการการแก้ไขแผนไม่มี "Module · Sprint" ใต้ชื่องาน (API ไม่ส่ง) · แสดงที่มา (แก้ในระบบ / นำเข้า / คำขอเลื่อน Due) แทน
- วันจบ Module: ส่วนต่างเป็นวันปฏิทิน ("+3 วัน") ตาม `slipDays` ของ Gantt ไม่ใช่วันทำการ (หน้าเว็บไม่มีปฏิทินวันหยุด) · "กระทบวันจบ N Module" นับ Module ที่คาดว่าจบช้ากว่าแผน · "แก้ไขแล้ว N งาน" นับจากรายการที่โหลดแล้ว
- route `/plan-changes` ถูก project shell (W00) ล็อกด้วย `project.baseline` แม้สเปกบอก `project.view` · ปุ่มตั้ง Baseline ซ่อนตามสิทธิ์เดียวกัน
- ยังไม่ได้เทียบภาพที่ 1440 / 390 px

### คำขอนอก lane

- A15 / API: endpoint ดาวน์โหลด Template เปล่า (เช่น `GET w/:ws/import-template.xlsx`) สำหรับปุ่ม "ดาวน์โหลด Template"
- A07 / API: ให้ `GET plan-changes` ส่ง `module` / `phase` ของงาน และวันจบ Module ตาม Baseline (เป็นวันทำการ) เพื่อให้ตรง Canvas โดยไม่ต้องโหลด Gantt ทั้งก้อน
- A15 / API: (ถ้าต้องการตาม Canvas) รับชื่อชีตตอนอัปโหลด และส่งระดับ "แนะนำ" / แถวที่พร้อมใน findings
- W00: พิจารณาให้ route `/plan-changes` ใน project shell ใช้ `project.view` ตามสเปก 03-api (ตอนนี้ต้อง `project.baseline`)
- W00: เพิ่มลิงก์เข้า `/w/:ws/import` ใน sidebar / หน้า Table (ตอนนี้เข้าได้จาก Onboarding และ URL)
