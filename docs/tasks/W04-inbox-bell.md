# W04 · Inbox และกระดิ่ง

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/work/[ws]/inbox/**` · `apps/web/src/features/bell/**` · `apps/web/messages/th/inbox-bell.json` |
| หน้าจอ | G (`design/canvas/Inbox.dc.html`) · K4 (`design/canvas/Bell.dc.html`) · M3 (`design/canvas/MobileInbox.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · 03-api › 3.9 แถว `me/notifications*` |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- ตัวกรอง 6 แบบพร้อมจำนวน, แผงรายละเอียดขวา, อนุมัติ / ปฏิเสธคำขอเลื่อน Due (`canDecide`), รับทราบ, เตือนพรุ่งนี้, Mark all as read
- กระดิ่ง + Toast จาก Realtime (ถ้า A17 merge แล้ว ไม่งั้น poll 60 วินาที)

## เสร็จเมื่อ

- [x] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [x] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [x] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

### หน้าที่เพิ่ม

| ที่ | ใช้ API | หมายเหตุ |
|---|---|---|
| `/w/[ws]/inbox` (G / M3) | `GET me/notifications?workspace=&filter=&cursor=` · `POST me/notifications/:id/read\|done\|snooze` · `POST me/notifications/read-all {workspace}` · `POST w/:ws/due-requests/:id/approve\|reject` | ตัวกรอง 6 แบบพร้อมจำนวน (`counts`) · จัดกลุ่ม วันนี้ / เมื่อวาน / ก่อนหน้า (เวลาไทย) · เลือกรายการ = เปิดแผงขวาและทำเครื่องหมายว่าอ่าน · แผงขวา: การ์ดงาน (สถานะ, Due, Assignee), ข้อความ, คำขอเลื่อน Due (วันเดิม → วันใหม่, เหตุผล, ปุ่มอนุมัติ / ปฏิเสธเมื่อ `canDecide` หรือผลการตัดสิน), รับทราบ (`done`), เตือนพรุ่งนี้ (`snooze preset: tomorrow`), "ทำไมฉันได้รับแจ้ง" · Mark all as read · โหลดหน้าถัดไปด้วย `nextCursor` · `?n=<id>` เปิดรายการนั้นทันที · มือถือ: รายการเต็มจอ แตะแล้วเป็นรายละเอียดพร้อมปุ่มกลับ |
| กระดิ่ง (`features/bell/Bell.tsx` · K4) | `GET me/notifications?filter=all\|unread\|mention&limit=8` (รวมทุก Workspace) · `POST read-all {}` · WebSocket `/api/v1/realtime` | คลิกเปิดแผง (ยังเป็นลิงก์ไป Inbox สำหรับ Ctrl/⌘-click และคงสัญญา `Bell({workspace,unread})` ของ shell) · แท็บ 3 แบบ · รายการลิงก์ไป `/w/<slug ของ Workspace นั้น>/inbox?n=<id>` · อ่านทั้งหมด · **Realtime**: subscribe `user:<me.id>` รับ `notification` → รีเฟรชตัวนับ / แผง / Inbox และแสดง Toast · เชื่อมไม่ได้หรือหลุด = poll ตัวนับทุก 60 วินาที และต่อใหม่แบบ backoff (สูงสุด 30 วินาที) |

### คำตัดสินที่เลือกเอง / ต่างจาก Canvas

- ปุ่ม "ตอบกลับ" (คอมเมนต์จาก Inbox), "ขอเปลี่ยนผู้รับผิดชอบ", "Unwatch งานนี้", "ปิดแจ้งเตือนประเภทนี้" และ "ส่งทาง: In-app · Email · LINE" ยังไม่ทำ (API ของ notification ไม่ส่งช่องทางที่ส่งจริง; ปิดประเภทอยู่ที่ Profile W17)
- Toast ของ Realtime บอกแค่ "มีการแจ้งเตือนใหม่ · ยังไม่อ่าน N" เพราะ A17 ส่งเฉพาะจำนวน (สัญญาณ ไม่มีเนื้อหา) — Canvas แสดงชื่อผู้ทำและปุ่มลัด
- คีย์ข้อความของชนิด Event ใช้ `__` แทน `.` (เช่น `issue__assigned`) เพราะ next-intl ห้ามจุดในคีย์ · **แก้แบบเดียวกันใน `messages/th/home-my-tasks.json` + `home-page.tsx` ของ W03** ซึ่งเดิมใช้คีย์มีจุดและจะ error ตอนแสดง Inbox บน Home
- ไม่เชื่อม WebSocket ระหว่าง test (`NODE_ENV=test`)

### คำขอนอก lane

- **A17**: ถ้าจะให้ Toast เหมือน Canvas ควรส่ง `{ actorName, eventType, issueKey }` ของแจ้งเตือนล่าสุดมากับ `notification` (ข้อมูลที่ผู้รับเห็นได้อยู่แล้ว)
- **A23**: response ของ list ควรมีช่องทางที่ส่งจริง (`deliveries`) สำหรับบรรทัด "ส่งทาง"
- **W00 (shell)**: แท็บล่างบนมือถือพร้อม badge Inbox ตาม M3

### ผล test / ตรวจ

`src/lib/inbox-bell.test.tsx` 7 ข้อ (MSW): ตัวกรองพร้อมจำนวน + ส่ง `workspace`, จัดกลุ่มตามวัน, จุดยังไม่อ่าน, เลือกแล้ว read + รับทราบ + เตือนพรุ่งนี้, อนุมัติ / ปฏิเสธคำขอเลื่อน Due, ไม่มีสิทธิ์ = แสดงผลแทนปุ่ม, Mark all as read, `?n=`, โหลดหน้าถัดไป, ว่าง / Error + requestId / 403, กระดิ่ง (แท็บ, ลิงก์, ไม่ส่ง workspace, อ่านทั้งหมด) · `pnpm --filter @friday/web typecheck test build` ผ่าน (web 127 test)

**ยังไม่ได้เทียบภาพกับ Canvas ที่ 1440 / 390 px** — ข้อแรกของ "เสร็จเมื่อ" จึงยังไม่ติ๊ก

### เบี่ยงจาก Canvas: สัดส่วนหน้า Inbox (ผู้ใช้ขอ 2026-11-11)

Canvas แบ่งรายการ / รายละเอียดเกือบครึ่งต่อครึ่ง ทำให้ที่ว่างไปอยู่ฝั่งรายการที่มีข้อความสั้น ผู้ใช้ขอให้คล้ายหน้ารายละเอียดของเว็บหางาน:
- จอใหญ่: รายการ 1/3 เป็นการ์ดทีละใบ (ใบที่เลือกมีกรอบสีหลัก) · รายละเอียด 2/3 ค้างกับที่ขณะเลื่อนรายการ · 761–1100 px ใช้ 2 : 3
- รายละเอียดมีส่วนหัวเด่น (ผู้ทำ, งาน, โครงการ / เวลา) รวมปุ่มทำงานหลักไว้ (อนุมัติ / ปฏิเสธ, เปิดงาน, รับทราบ, เตือนพรุ่งนี้) · เนื้อหาด้านล่างกว้างไม่เกิน 760 px
- มือถือคงตาม M3 (รายการ → รายละเอียด)
