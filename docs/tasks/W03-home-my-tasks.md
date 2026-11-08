# W03 · Home และ My Tasks (รวมมือถือ)

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A10 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/work/[ws]/page.tsx` · `apps/web/app/work/[ws]/my-tasks/**` · `apps/web/messages/th/home-my-tasks.json` |
| หน้าจอ | E (`design/canvas/Home.dc.html`) · F (`design/canvas/MyTasks.dc.html`) · M2 (`design/canvas/MobileMyTasks.dc.html`) · M5 (`design/canvas/MobileHome.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · 03-api › 2 หน้า E, F |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- ตามหน้าจอทั้ง desktop และมือถือ · ลากไปกลุ่ม "สัปดาห์หน้า" = แก้ Due หรือเปิด K3 ตามสิทธิ์
- อนุมัติคำขอเลื่อน Due จาก Home

## เสร็จเมื่อ

- [x] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [x] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [x] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

### หน้าที่เพิ่ม

| Route | ใช้ API | หมายเหตุ |
|---|---|---|
| `/w/[ws]` (Home · E / M5) | `GET w/:ws/home` · `GET me/notifications?workspace=&limit=4` · `POST w/:ws/due-requests/:id/approve\|reject` | ทักทายตามเวลาไทย · KPI 5 ช่อง · "สิ่งที่รอคุณวันนี้" (คำขอเลื่อน Due พร้อมปุ่มอนุมัติ/ปฏิเสธเมื่อ `canDecide` + งานรอ Review) · โปรเจกต์ของฉัน (เรียงใกล้ Go-live / Health / ชื่อ) · เปิดล่าสุด · รอฉัน Review · Inbox 4 รายการ · 30 วันข้างหน้า · Workload ทีมสัปดาห์นี้ (ไม่แสดงเมื่อ API ส่ง `null` เช่น Guest) |
| `/w/[ws]/my-tasks` (F / M2) | `GET w/:ws/my-issues?tab&group&projectKey` · `GET p/form-options` · `PATCH issues/:key` (If-Match) · `POST issues/:key/due-requests` | 4 แท็บพร้อมจำนวน · ชิปโปรเจกต์ · จัดกลุ่ม Due / Project / Status (ย่อ "ภายหลัง" กับ "ไม่มีวันที่" ไว้ตาม Canvas) · ติ๊กปิดงาน = ย้ายไปสถานะหมวด done แรกของ Workflow ประเภทงานนั้น (ยกเลิกติ๊ก = หมวด todo) · สรุปของฉัน · แยกตามโปรเจกต์ · กราฟ Man-Day รายวันของสัปดาห์ |

**เลื่อน Due**: ลากแถวไปวางที่หัวกลุ่ม "วันนี้ / สัปดาห์นี้ / สัปดาห์หน้า" (ปลายทาง = วันนั้น หรือวันศุกร์ของสัปดาห์) หรือกดปุ่มปฏิทินที่แถว / ปัดซ้ายบนมือถือ → Dialog แก้ Due (`PATCH planEnd`) · ถ้า API ตอบ 403 `due_change_requires_approval` Dialog สลับเป็นฟอร์มขอเลื่อน Due (K3: Due ใหม่ + เหตุผล + รายละเอียด) · ปัดขวาบนมือถือ = ปิดงาน

**สถานะตาม M1**: กำลังโหลด (`LoadingState`) · ว่าง (`EmptyState`) · Error พร้อม requestId (`ErrorState`) · 403 (`Forbidden`) · ปุ่มอนุมัติซ่อนตาม `canDecide`

ไฟล์: `app/work/[ws]/page.tsx`, `app/work/[ws]/my-tasks/page.tsx`, `app/work/[ws]/my-tasks/_components/*` (Home ใช้ component จากโฟลเดอร์นี้เพื่ออยู่ใน lane), `messages/th/home-my-tasks.json`, test `src/lib/home-my-tasks.test.tsx`

### คำตัดสินที่เลือกเอง / ต่างจาก Canvas

- ปุ่ม "+ New task" ไม่ใส่ (ระดับ Workspace ยังไม่มีฟอร์มสร้างงานที่ไม่ผูกโปรเจกต์ · ใช้ "+ New" ของแถบบนใน shell) · ช่อง "+ เพิ่มงาน… พิมพ์ชื่อแล้วกด Enter" ท้ายรายการไม่ได้ทำ (ต้องเลือกโปรเจกต์/Module)
- ปุ่มสลับ List / Board / Calendar ของ My Tasks ไม่ได้ทำ (มีแต่ List)
- กราฟ "สัปดาห์นี้" ใน My Tasks คำนวณฝั่งหน้าเว็บจากงานที่แสดง (Man-Day ÷ วันทำงาน จ.–ศ. ในช่วงงาน ÷ จำนวนผู้รับผิดชอบ) **ไม่หักวันหยุดบริษัท** · เส้นประ = 1 MD/วัน
- คลิกชื่องานเปิด `/w/:ws/p/:project/board?issue=KEY` (Drawer ของ W02 อยู่ใน project layout)
- ลิงก์ Inbox ทุกแถวไปหน้า Inbox (W04) · ข้อความกิจกรรมแปลจาก `eventType` (ไม่รู้จัก = "มีความเคลื่อนไหวใน")

### คำขอนอก lane

- **A10**: Home ควรส่งสีโปรเจกต์ของงานใน `waiting` และ `myRole` ในการ์ดโปรเจกต์ (Canvas เขียน "คุณเป็น Lead / PM") · `waiting.approvals` ควรมี `impact` สั้น ๆ ให้แสดงแบบมือถือ M5 · My Tasks ควรมีจำนวน MD ต่อวันจากเซิร์ฟเวอร์ (หักวันหยุด/วันลาจริง)
- **W00 (shell)**: แท็บล่างบนมือถือ (Home / My Tasks / Projects / Inbox / Profile) และปุ่ม FAB สร้างงาน ตาม M2/M5 เป็นของ shell
- **W04**: ลิงก์ Inbox ส่ง `?n=<id>` เพื่อเปิดรายการตรง ๆ ได้ถ้าหน้าดังกล่าวรองรับ

### ผล test / ตรวจ

`src/lib/home-my-tasks.test.tsx` 11 ข้อ (MSW): Home แสดงทุกส่วน, อนุมัติ/ปฏิเสธ + toast + โหลดใหม่, ไม่มีสิทธิ์ตัดสิน = ไม่มีปุ่ม, ว่าง, Error + requestId, 403 · My Tasks แท็บ/กลุ่ม/ย่อขยาย/ชิปโปรเจกต์/สรุป, ติ๊กปิดงาน (statusId Done + If-Match), ลากไป "สัปดาห์หน้า" = Due ศุกร์, 403 → ฟอร์ม K3 ส่งคำขอ, แท็บว่าง, Error, 403, ตัวช่วยคำนวณ · `pnpm --filter @friday/web typecheck test build` ผ่าน (web 120 test)

**ยังไม่ได้เทียบภาพกับ Canvas ที่ 1440 / 390 px** (ไม่มีภาพหน้าจอจากเบราว์เซอร์ในรอบนี้ · ใช้ class และระยะตาม Canvas) — ข้อ "หน้าตรงกับไฟล์ Canvas" จึงยังไม่ติ๊ก ควรเปิด dev server ตรวจด้วยตา
