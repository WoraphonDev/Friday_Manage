# A23 · กระจายแจ้งเตือนจาก Event และแจ้งเตือนตามเวลา

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | T00, A16 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/notifications/**` · `apps/api/test/notification-fanout.e2e.test.ts` |
| หน้าจอ | G (`design/canvas/Inbox.dc.html`) · K4 (`design/canvas/Bell.dc.html`) · I (`design/canvas/Profile.dc.html`) |
| สเปก | 03-api › Event ที่ระบบส่งต่อ (คอลัมน์ "ส่งหาใคร") · 03-api › 3.9 |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- ฟัง `EventBus` ทุก Event ในตาราง แล้วสร้าง `notifications` ผ่าน `Notifier` ตามผู้รับเริ่มต้น · ตัดผู้ทำเอง · เคารพ `user_notification_pref` (ช่องทาง in_app) · ใส่ `reason`
- `issue.status_changed` ที่สถานะปลายทางชื่อ Review → แจ้ง Reviewer เป็น `issue.review_requested`
- งานตามเวลา (A16): `issue.due_soon` ตาม `due_reminder` ของแต่ละคน 08:00 · สรุปงานเลยกำหนดให้ Lead 09:30 วันทำการ · digest
- `due_request.*` และ `project.admin_joined` ส่งอยู่แล้ว: อย่าส่งซ้ำ

## เสร็จเมื่อ

- [x] test: ทุก Event ในตารางได้ผู้รับตรงตามคอลัมน์ "ส่งหาใคร" · ปิด pref แล้วไม่ได้รับ (ข้อปิด In-app รันเมื่อ enum มี `in_app` · ดูคำขอนอก lane)
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- ส่งออกนอกแอป (A24, A25)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

- ไม่มี endpoint ใหม่ · `NotificationFanout` ฟังทุก Event ใน `EventBus` แล้วส่งเข้าคิว `notifications.fanout` (A16) เพื่อไม่ให้คำขอหลักช้า · โหมด inline รันทันที · กติกาผู้รับ เหตุผล และเหตุการณ์ที่ล็อก In-app อยู่ที่ `notifications/rules.ts` ให้ A24 / A25 ใช้ชุดเดียวกัน
- ผู้รับ (03-api › Event ที่ระบบส่งต่อ) · ตัดผู้ทำเองทุกกรณี:
  - `issue.assigned` → Assignee ใหม่ · คนที่ถูกถอดออกได้ด้วย (`payload.removed`) ตามแถว "ถูกถอดออกจากงาน" ของ Canvas I
  - `issue.status_changed` → Watcher + ผู้รับผิดชอบ Task แม่เมื่อ Sub-task เปลี่ยน · ย้ายเข้าสถานะชื่อ Review → Reviewer ได้ `issue.review_requested` แทน (ไม่ซ้ำกับการเปลี่ยนสถานะ)
  - `issue.updated` → Watcher เฉพาะ `planStart`, `planEnd`, `priority`, `severity`, `title` ("สถานะ / Due / Priority" ใน Canvas I) · สถานะและผู้รับผิดชอบมี Event ของตัวเอง จึงไม่แจ้งซ้ำ
  - `issue.commented` → Watcher ยกเว้นคนที่ถูก @mention ในคอมเมนต์เดียวกัน · `issue.mentioned` → คนที่ถูก mention
  - `bug.created` → BA (Assignee ได้ `issue.assigned` ในคำขอเดียวกันอยู่แล้ว) · `bug.reopened` → Assignee + BA
  - `test_run.failed` → Assignee · `sprint.*` → สมาชิกโปรเจกต์ · `plan.changed`, `project.health_changed`, `member.invited` → PM (= Project Owner) · `member.joined` → คนที่ถูกเพิ่ม + PM · `import.completed` → ผู้นำเข้า (ไม่ตัดผู้ทำเอง เพราะเป็นงานคิวที่เสร็จทีหลัง)
  - `issue.created`, `issue.deleted`, `report.weekly` ไม่มีผู้รับใน Inbox · `due_request.*` และ `project.admin_joined` ส่งที่ต้นทางอยู่แล้ว จึงไม่ฟัง
- กรองผู้รับก่อนส่งทุกครั้ง (04-permissions ข้อ 5): สมาชิก Workspace ที่ active, เปิดโปรเจกต์ได้ (Owner / สมาชิก / visibility workspace ที่ไม่ใช่ Guest), Guest Viewer เฉพาะงานที่แชร์และไม่ใช่ Bug, ไม่แจ้งงาน / โปรเจกต์ที่ถูกลบ · อ่านผ่าน `SYSTEM_DB` เพราะงานคิวไม่มีผู้ใช้ให้ RLS และต้องเขียน `notifications` ของคนอื่น (เหตุผลอยู่ในคอมเมนต์)
- Pref: ข้ามคนที่ปิด In-app ของ event นั้น (`user_notification_prefs.event_type` = ชื่อ Event · `channel` = `in_app` · `enabled = false`) ยกเว้นเหตุการณ์ที่ Canvas I ล็อก In-app: มอบหมาย, Review, @mention, คำขอเลื่อน Due, เลยกำหนด, ถูกเพิ่มเข้าโปรเจกต์ · การปิด Email / LINE ไม่กระทบ Inbox
- งานตามเวลา (เวลาไทย):
  - 08:00 `notifications.due-reminders`: ใกล้ครบกำหนดตาม `due_reminder` ของแต่ละคน นับวันทำการตามปฏิทินโปรเจกต์ (`1d_and_today` = วันทำการก่อนหน้า + วันครบกำหนด · `3d` = 3 วันทำการก่อน · `today_only`) และแจ้ง Assignee ครั้งแรกที่งานเลยกำหนด
  - 09:30 `notifications.overdue-summary`: สรุปงานเลยกำหนดให้ PM โปรเจกต์ละ 1 รายการ (สูงสุด 20 งาน) เฉพาะวันทำการของโปรเจกต์ · "Overdue ส่ง PM ด้วย" ใช้สรุปนี้แทนการแจ้งทีละงาน
  - 08:30 `notifications.digest`: งานวันนี้ + เลยกำหนด + รอ Review ตาม `digest` (workdays / daily / off) · Canvas I ปิด In-app ของ digest เป็นค่าเริ่มต้น จึงเข้า Inbox เฉพาะคนที่เปิดเอง (`digest.daily`) · Email / LINE เป็นของ A24 / A25
  - ทุกงานรันซ้ำได้: `Notifier` รับ `dedupeKey` (เก็บใน `payload.dedupeKey`) แล้วข้ามผู้รับที่เคยได้แล้ว · handler รับ `{ date }` ไว้ทดสอบ / รันย้อนหลัง
- `Notifier.notify` เพิ่ม `dedupeKey` แบบไม่บังคับ · ผู้เรียกเดิมไม่ต้องแก้
- Test `notification-fanout.e2e.test.ts` 19 ข้อ: ทุก Event ในตาราง (Event ที่ยังไม่มีต้นทางส่ง ทดสอบผ่าน `EventBus.publish`), ไม่ส่งซ้ำ, สิทธิ์ผู้รับ, pref, ตารางเวลาและวันทำการ, รันซ้ำไม่ซ้ำ · 2 ข้อ (ปิด In-app, digest) ข้ามเมื่อ enum ยังไม่มี `in_app` และผ่านเมื่อเพิ่มค่านี้ในฐานทดสอบแยก
- แก้ไฟล์กลางที่ประสานแล้ว: `test/api.e2e.test.ts` บรรทัดที่เช็ก Inbox ของผู้ขอเลื่อน Due ว่าง → เช็กเฉพาะรายการ `due_request.*` (เจตนาเดิม "ผู้ขอไม่ได้รับแจ้งเรื่องที่ตัวเองทำ") เพราะผู้ขอได้รับแจ้ง "ได้รับมอบหมายงาน" ที่ถูกต้องแล้ว
- `pnpm typecheck` และ `pnpm test` ผ่าน: DB 105 + API 194 (ข้าม 8 = เดิม 6 + `in_app` 2) + Web 53
- คำขอนอก lane:
  - งาน DB: เพิ่ม `in_app` ใน enum `notification_channel` (กำลังเปิดเป็น PR แยก)
  - invitations / A14: ส่ง `member.invited` เข้า EventBus (ตอนนี้เขียนแค่ Audit)
  - A15: ส่ง `import.completed` เข้า EventBus เมื่อนำเข้าเสร็จ (ใส่ `data.userId` ของผู้นำเข้า)
  - A06 / A08 / A12: ส่ง `sprint.*`, `project.health_changed`, `test_run.failed` · ผู้รับรองรับไว้แล้ว
  - A20 / W17: เก็บ pref ด้วย `event_type` = ชื่อ Event และ `channel = in_app` · แถวที่ล็อกใน Canvas I ไม่ต้องให้ปิด
- คำถามที่ค้าง: PM = Project Owner คนเดียว (ไม่รวม Admin ของโปรเจกต์) · งานเลยกำหนดแจ้ง Assignee แค่วันแรกที่เลยกำหนด ไม่แจ้งซ้ำทุกวัน

