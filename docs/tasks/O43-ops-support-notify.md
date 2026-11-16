# O43 · Friday Ops: วันหยุด ธปท. สถานะ Support ประวัติการส่ง ประกาศ และ Error rate

| | |
|---|---|
| Wave | O-5 (รอบ 4) · ผู้ใช้อนุมัติหน้าจอ 16 พ.ย. 2569 |
| รอ merge | O44-schema |
| Lane (แก้ได้เฉพาะ) | `apps/ops-api/src/{support (ยกเว้น support.service.ts ของ O42),deliveries,announcements,entitlements,system,push,auth/auth.controller.ts (logout),mobile}/**` · `apps/ops-api/test/help.e2e.test.ts` · `apps/api/src/help/routing.ts` + `tickets.service.ts` (เฉพาะคืนเข้าคิว) · `apps/api/src/channels/email-feedback.ts` · requestId: `apps/api/src/core/events.ts` (เพิ่ม field ต่อท้ายเท่านั้น) + จุดที่เขียน `notifications` · ตัวนับ 5xx: `apps/api/src/common/errors.ts` + endpoint ภายใน · `apps/ops-web/app/(console)/{support (ยกเว้น sessions),deliveries,announcements,entitlements,system,m}/**` · `apps/ops-web/app/(console)/workspaces/_parts/Announce.tsx` · test ของเรื่องเหล่านี้ |
| หน้าจอ | `design/proposals/round4/04-support-notify.html` › S1–S12 |
| สเปก | [01-entities](../spec/01-entities.md) › `system_alert` `ops_setting` · decisions ข้อ 15 (Man-Day ไม่นับวันหยุด ธปท.) |

อ่าน [README](README.md) ก่อนเริ่ม

## ทำอะไร

- **S1–S2 วันหยุด:** ตัวดึง API วันหยุดสถาบันการเงินของ ธปท. (`BOT_API_CLIENT_ID` · ไม่มีค่า = ปิด แสดงสถานะ) ทุกวัน 06:00 (ธ.ค. ดึงปีถัดไป) เขียนปฏิทินของระบบ (`origin='bot'`, `synced_at`, `sync_error`) · เพิ่ม / ลบวันหยุดเอง (`origin='manual'`) · หน้าต่างตรวจก่อนบันทึกพร้อมจำนวนโปรเจกต์ / งานที่กระทบ และคำนวณ Plan End ใหม่ (ใช้ logic เดิมของ API ลูกค้า) · SLA ใช้ปฏิทินใหม่
- **S3–S5 สถานะ:** ออฟไลน์อัตโนมัติเมื่อออกจากระบบ / cookie หมดอายุ / ไม่มีการใช้งาน N นาที (ค่าเริ่ม 15, `last_seen_at` จากการเรียก team ทุกนาที) · `presence_reason` · Toast ตอนกลับมา · แจกเรื่องในคิวกลางใหม่ทุก 1 นาทีและทันทีที่มีคนออนไลน์ (route() เดิม) · ลูกค้าตอบเรื่องที่ปิดแล้วแต่คนเดิมออฟไลน์ → คืนเข้าคิว (ทั้ง ops-api และ API ลูกค้า) · ค่าใหม่อยู่ใน `support_settings.config`
- **S6:** หน้า Ticket แสดงไฟล์แนบและบริบท (หน้า, requestId, บทความ, เบราว์เซอร์, ผลกระทบ) ที่ลูกค้าส่งมา
- **S7:** เก็บ requestId กับ `notifications` · ค้นประวัติการส่งด้วย `#เลข Ticket` (การส่งถึงผู้เปิด 7 วันก่อนเปิดถึงตอนนี้ + ที่ผูกไว้) และ `req_…` · ข้อความช่องค้นตาม Canvas
- **S8–S9 ประกาศ:** ผู้รับ "ตามตัวกรอง" (หาตอนส่ง) และ "ลูกค้าทุกราย" (`target_mode`, `target_filter`, > 1,000 ต้องแตะกุญแจ) · P2 ติ๊ก "ส่งประกาศถึงลูกค้าที่ถูกกระทบ (C8)" ร่างประกาศไปกับคำขออนุมัติ ส่งเมื่ออนุมัติ ยกเลิกเมื่อปฏิเสธ · รายชื่อผู้ถูกกระทบครบ · ตรวจแจ้งล่วงหน้า ≥ 30 วัน
- **S10–S12 Error rate:** ตัวนับ 5xx / คำขอทั้งหมดใน API (หน้าต่าง 5 นาที, endpoint ภายในที่ ops-api อ่าน) · การ์ดและกราฟในสถานะระบบ · เกณฑ์ใน `ops_settings` key `alerts` (2% · 5 นาที · ขั้นต่ำ 200 คำขอ · ช่องทาง · เปิดเหตุขัดข้องอัตโนมัติ ปิดเป็นค่าเริ่มต้น) · `system_alerts` + Push / อีเมล วิศวกรและ Owner · แจ้งซ้ำทุก 30 นาที · กลับปกติ 10 นาทีแจ้ง · "รับทราบ" บนหน้าเหตุขัดข้องมือถือ · บันทึกผล Push ที่ส่งไม่ถึง
- **เบื้องหลัง:** ตรวจลายเซ็น SNS + TopicArn ที่อนุญาต + ยืนยัน SubscriptionConfirmation อัตโนมัติ (test ด้วยใบรับรองจำลอง) · แก้ `help.e2e` ให้ใช้ฐานข้อมูลเดียวกับ test อื่น
- ประกาศจากหน้า Workspaces (O42) ส่ง `filter` ปัจจุบันเข้า `AnnounceDrawer` ได้

## เสร็จเมื่อ

- [ ] หน้าตรงกับข้อเสนอที่ 1440 px · ใช้งานได้ที่ 390 px
- [ ] e2e ops-api + API ลูกค้า (ดึงวันหยุดจาก API จำลอง, ออฟไลน์อัตโนมัติ + แจกใหม่, ค้นด้วย Ticket / requestId, ประกาศตามตัวกรอง, C8 หลังอนุมัติ, Error rate เกิน / กลับปกติ, SNS) + component test ด้วย MSW · `help.e2e` ผ่าน
- [ ] `pnpm typecheck` และ test ของแพ็กเกจที่แก้ผ่าน
- [ ] deploy Docker ในเครื่องตาม CLAUDE.md และตรวจผ่าน :4000 / :3000 · ทดสอบ Push บนเครื่องจริงผ่าน staging (บันทึกผล)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน -->
