# ผลแก้ Bug จาก claude-bug-review-2026-11-06

แก้ครบ 14 รายการจาก [claude-bug-review-2026-11-06.md](claude-bug-review-2026-11-06.md) · ทุกข้อมี regression test ที่ล้มกับโค้ดเดิมและผ่านกับโค้ดใหม่ (ตรวจด้วยการถอดโค้ดแก้ออกแล้วรัน test ซ้ำ ยกเว้นที่ระบุ) · ผล `pnpm --filter @friday/api test` หลังแก้ทุกข้อ: ผ่านทั้งหมด

| ID | PR | สิ่งที่เปลี่ยน | Regression test |
|---|---|---|---|
| BUG-01 | #70 | `hooks/github/setup` ต้องมี `code` จาก OAuth ตอนติดตั้ง แล้วตรวจ `GET /user/installations` ก่อนผูก · ต้องตั้ง `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | `git.e2e` › BUG-01 |
| BUG-02 | #64 | realtime: JSON ที่ไม่ใช่ object → `invalid_message` · cookie decode ไม่ได้ → 401 · รับ rejection ทุกทางเข้า (upgrade, message, recheck, poll) | `realtime.e2e` › BUG-02 (2 ข้อ) |
| BUG-03 | #65 | `findApiToken` ปฏิเสธ token ของบัญชีที่ `users.disabled_at` | `api-tokens.e2e` › BUG-03 |
| BUG-04 | #66 | test-runs ของ Guest Viewer ตัดผู้ทดสอบ (แสดง "ทีมพัฒนา"), Bug, ไฟล์, note, commit | `qa.e2e` › BUG-04 |
| BUG-05 | #67 | `deliver()` ตรวจผู้รับรายคนซ้ำตอนส่ง (สมาชิก active, บัญชีไม่ถูกปิด, เห็นโปรเจกต์/งาน, pref ล่าสุด) · ไม่ผ่าน = `failed` "ยกเลิกการส่ง: …" ไม่ retry | `channels.e2e` › BUG-05 (3 ข้อ) |
| BUG-06 | #68 | ลิงก์ PUT ชี้ `staging/` · ยืนยันแล้วย้ายไป key ถาวร (Local: link ไม่ทับ · S3: CopyObject + CopySourceIfMatch) | `files.e2e` › BUG-06 |
| BUG-07 | #68 | ล็อกต่อ upload + ตรวจ key ถาวรซ้ำ → 409 `upload_already_used` | `files.e2e` › token ครั้งเดียว + ส่งพร้อมกัน |
| BUG-08 | #68 | ล็อกพื้นที่ต่อ Workspace แล้วตรวจโควตาซ้ำตอนยืนยัน | `files.e2e` › โควตาตอนยืนยัน + พร้อมกัน |
| BUG-09 | #71 | 7 จุดเปลี่ยนเป็น `access.guestViewer` (files, calendar, gantt + auto-schedule, insights, saved-views, repositories) · Settings / รายชื่อองค์กรยังปิดทุก Guest | `guest-member.e2e` (ใหม่, matrix) |
| BUG-10 | #72 | สร้างโปรเจกต์ใส่กฎ Workflow ค่าเริ่มต้นของ Standard/Bug ในธุรกรรมเดียวกัน · โปรเจกต์เดิมไม่ใส่ย้อนหลัง (ดู PR) | `default-rules.e2e` (ใหม่), `api.e2e` |
| BUG-11 | #73 | cursor ทึบ = เวลา microsecond + id · `(changed_at, id) <` · cursor เสีย → 400 | `gantt.e2e` › plan-changes |
| BUG-12 | #73 | ราคาปี: override ปี → override เดือน × 10 → catalog × 10 | `public.e2e`, `plans.e2e` |
| BUG-13 | #67 | ปิด In-app ไม่ตัดผู้รับ แต่สร้างแถว `notifications.in_app = false` (migration 0011) · RLS ซ่อนจาก Inbox · Email/LINE/Webhook ยังส่ง | `channels.e2e` › BUG-13 (3 ข้อ) |
| BUG-14 | #70 | ตาม `Link: rel="next"` ทุกหน้า (เฉพาะ api.github.com) · หน้าไหนล้ม = sync ล้มก่อนลบ | `git.e2e` › BUG-14 (2 ข้อ) |

## สิ่งที่พบเพิ่มระหว่างแก้

- **realtime พลาดแจ้งเตือนที่ commit ช้า** (#57): `created_at = now()` คือเวลาเริ่มธุรกรรม แถวที่ commit หลังรอบ poll หลุด cursor ถาวร · แก้ด้วยช่วงอ่านซ้อน 30 วินาที + ตัดซ้ำด้วย id
- **test 2FA สุ่มล้ม** (#53): คำนวณ TOTP ใหม่ข้ามรอบ 30 วินาที

## ข้อจำกัดที่ยังเหลือ (ไม่ได้แก้ในรอบนี้)

- BUG-01: `state` ยังไม่ใช่ nonce ใช้ครั้งเดียว · ป้องกันด้วย `code` ของ GitHub ที่ใช้ได้ครั้งเดียวและผูกกับบัญชีผู้ติดตั้ง
- BUG-06: ไฟล์ใน `staging/` ที่อัปโหลดแล้วไม่ยืนยันยังค้าง · ควรตั้ง S3 lifecycle ลบ `staging/` อายุ > 1 วัน (I01)
- BUG-13: Daily digest ทาง Email ยังสร้างเฉพาะคนที่เปิด In-app ของ digest · ประวัติการส่งฝั่งผู้รับไม่เห็นรายการจากแถว `in_app = false` (Admin เห็น)
- BUG-10: โปรเจกต์ที่สร้างก่อนแก้ยังไม่มีแถวกฎ · Admin เปิดได้ที่ Settings › Workflow

## วิธีตรวจซ้ำ

`docs/reviews/claude-review-repro.e2e.test.ts.txt` ตรวจ **พฤติกรรมผิดเดิม** หลังแก้จึงควรล้มทุกข้อ (R01–R14) · test ที่ยืนยันพฤติกรรมถูกต้องอยู่ใน suite ปกติตามตารางข้างบน
