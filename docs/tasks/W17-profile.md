# W17 · Profile และการตั้งค่าแจ้งเตือนของฉัน

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A13, A20 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/w/[ws]/profile/**` · `apps/web/messages/th/profile.json` |
| หน้าจอ | I (`design/canvas/Profile.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · 03-api › 3.1, 3.9 แถว notification-prefs |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- ข้อมูลส่วนตัว, ภาษา / ปี, ตารางแจ้งเตือน, ผูก LINE, 2FA, Session, วันลา, iCal

## เสร็จเมื่อ

- [x] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [x] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [x] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

### สิ่งที่ทำ

หน้า `w/[ws]/profile` (`page.tsx` server component → `_components/profile-page.tsx`) · การ์ดสรุปด้านซ้าย + 4 แท็บ (แท็บอยู่ใน `?tab=profile|notify|hours|sec` เปิดที่ `notify` ตาม Canvas) · ข้อความใน `messages/th/profile.json` (namespace `profile`) · test `src/lib/profile.test.tsx` 15 ข้อ

| ส่วน | API ที่ใช้ |
|---|---|
| การ์ดสรุป | `GET me` (จาก shell) · `GET w/:ws/me/membership` · `GET me/line` · `GET w/:ws/leaves` (สถานะ "ลา" วันนี้) · `GET w/:ws/my-issues?tab=assigned&group=due` (งานที่เปิด / เลยกำหนด) · เปลี่ยนรูป `PATCH me { avatarUrl }` |
| ข้อมูลส่วนตัว | `PATCH me` (ชื่อ, นามสกุล, ชื่อที่แสดง, โทร, เกี่ยวกับฉัน, timezone, ภาษา, พ.ศ./ค.ศ.) + `PATCH w/:ws/me/membership` (ตำแหน่ง, แผนก) ส่งเฉพาะที่เปลี่ยน · อีเมลใหม่ → `POST me/email:change` → `POST me/email:confirm { code }` |
| การแจ้งเตือน | `GET/PUT me/notification-prefs` (ส่งทั้งเมทริกซ์ยกเว้นช่องที่ล็อก ตามคำแนะนำของ A20) · `GET/PUT me/notification-settings` · คืนค่าเริ่มต้น = `prefs: [], reset: true` + settings ค่าเริ่มต้น |
| ผูก LINE | `POST me/line/link-code` → ถาม `GET me/line` ทุก 5 วินาทีจน `boundAt` เปลี่ยน · `POST me/line/test` · `DELETE me/line` |
| เวลาทำงาน / วันลา | `PATCH w/:ws/me/membership` (Capacity, เวลาเริ่ม/เลิกส่งคู่กัน, วันทำงาน) · `GET/POST/DELETE w/:ws/leaves` (409 `leave_overlap`, ครึ่งวันเฉพาะวันเดียว, วันลาจาก HR ไม่มีปุ่มลบ, Guest ไม่มีปุ่มเพิ่ม) |
| iCal | `GET/POST/DELETE me/calendar-feeds` · URL แสดงครั้งเดียวใน Dialog |
| ความปลอดภัย | `GET me/identities` · `POST me/password:change` · `GET me/mfa` + `mfa:setup` → `mfa:enable` → Backup code · `mfa:disable` · `mfa/backup-codes:regenerate` · ผูก Google / Microsoft ผ่าน `auth/oauth/:provider/start?mode=link&next=…?tab=sec` · `DELETE me/identities/:id` · `GET/DELETE me/sessions` · `DELETE me/sessions/:id` |

- secret ของ 2FA, Backup code, รหัสผูก LINE และ URL iCal อยู่แค่ใน state ของ Dialog / แผง ปิดแล้วล้างทิ้ง (ไม่เก็บใน React Query cache) · test ตรวจว่าเปิดใหม่ไม่เห็นซ้ำ
- สถานะ M1: แต่ละส่วนมี LoadingState · ErrorState พร้อม requestId · 403 → Forbidden · วันลา / ลิงก์ปฏิทินว่างมีข้อความ · หน้านี้เป็นของตัวเองจึงไม่มีปุ่มที่ขึ้นกับ `my-permissions` (ซ่อนตาม role ของ Workspace แทน: Guest ลาไม่ได้, 2FA ที่ Workspace บังคับไม่มีปุ่มปิด)
- ยังไม่ได้เทียบภาพที่ 1440 / 390 px ในเบราว์เซอร์ (checkbox แรกเว้นไว้) · layout ใช้ค่า CSS จาก Canvas (การ์ด 280–340px + การ์ดหลัก flex-wrap, ตาราง `minmax(220px,1fr) repeat(3,76px)` เลื่อนแนวนอนได้บนมือถือ)

### ต่างจาก Canvas และเหตุผล

- **การ์ดสรุป "เสร็จเดือนนี้" → "เลยกำหนด"**: ไม่มี API นับงานที่เสร็จในเดือน (`my-issues` นับเสร็จแค่วันนี้) จึงแสดงงานเลยกำหนดของฉันแทน
- **ป้ายโปรเจกต์** แสดง role ของฉันในโปรเจกต์ (Admin / Member / Viewer) จาก `projects[].myRole` · Canvas เขียน "Lead · Admin" แต่ API ไม่มีบทบาท Lead แยก
- **ตารางแจ้งเตือน** ใช้ 20 แถวจาก API (`me/prefs-catalog.ts`) ไม่ใช่ 16 แถวของ Canvas (A20 รวม/แยกบางแถว เช่น มอบหมาย + ถอดออกเป็นแถวเดียว, เพิ่ม Bug / Sprint / แผน)
- **"รูปแบบวันที่"** ใน Canvas ซ้ำกับ "รูปแบบปี" (API มีแค่ `yearFormat`) จึงเหลือ select เดียวและแสดงตัวอย่างวันที่ใต้ช่อง
- **อีเมล** แก้ในช่องแล้วกดบันทึก → เปิด Dialog ยืนยันรหัสผ่าน + รหัส 6 หลัก (Canvas ไม่มีขั้นนี้ แต่ API บังคับยืนยัน)
- **เปลี่ยนรูป** รับเป็นลิงก์รูป เพราะยังไม่มี API อัปโหลดรูปโปรไฟล์
- **แผงผูก LINE** ไม่มี QR code: ผู้ใช้ทั่วไปอ่านข้อมูล OA (`w/:ws/channels/line-oa`) ไม่ได้ และยังไม่มี lib สร้าง QR · แสดงข้อความให้ค้นหา OA แทน · รหัสไม่ออกเองตอนเปิดแผง ต้องกด "ขอรหัส" (กันสร้างรหัสทิ้งทุกครั้งที่เปิด)
- **การ์ด "กลุ่มทีม"** ปุ่ม "ดู" ไปที่ Settings › การแจ้งเตือน ของโปรเจกต์แรกที่เป็นสมาชิก (ไม่มีโปรเจกต์ = ไม่มีปุ่ม)
- **แท็บเวลาทำงาน** เพิ่มปุ่ม "บันทึกเวลาทำงาน" (Canvas ไม่มีปุ่ม) · วันทำงานเป็นปุ่มกดสลับ (`aria-pressed`) · เพิ่มส่วน "ปฏิทิน (iCal)" ท้ายแท็บนี้ (Canvas ไม่มี แต่อยู่ในขอบเขตงาน)
- **แท็บความปลอดภัย** เพิ่มปุ่มเปิด / ปิด 2FA, ออก Backup code ใหม่, แถว Microsoft, ปุ่มเชื่อม / ยกเลิกการเชื่อม และ "ออกจากระบบทุกเครื่องยกเว้นเครื่องนี้" · Dialog 2FA แสดงรหัสลับเป็นข้อความ + ลิงก์ `otpauth://` (ไม่มี lib สร้าง QR)

### คำขอนอก lane

- **A20 / W00**: ถ้าต้องการ "เสร็จเดือนนี้" ตาม Canvas ต้องมีตัวนับจาก API (เช่น `my-issues` คืน `doneThisMonth`)
- **API อัปโหลดรูปโปรไฟล์** (เช่น `POST me/avatar`) · ตอนนี้ใช้ URL
- **A24**: endpoint ให้สมาชิกอ่าน LINE ID / QR ของ OA ของ Workspace (ไม่ต้องเป็น Admin) เพื่อแสดงขั้นที่ 1 ตาม Canvas · และถ้ามี Event WebSocket ตอนผูกสำเร็จ หน้าเว็บจะเลิก poll ได้
- **W00**: ถ้าจะมี QR code (2FA / LINE) ต้องเพิ่ม dependency สร้าง QR ใน UI kit

### ผล test

`src/lib/profile.test.tsx` 15 ข้อ (การ์ดสรุป, เปลี่ยนรูป, เมทริกซ์ + ค่าตั้ง + คืนค่าเริ่มต้น, ผูก LINE จนสำเร็จ / ทดสอบ / ยกเลิก, ข้อมูลส่วนตัว + เปลี่ยนอีเมล, เวลาทำงาน + วันลา, iCal, Session + รหัสผ่าน + Google, 2FA ครบวงจร, 2FA ที่บังคับ, Guest, สถานะโหลด / Error / 403 / ว่าง, helper) · `pnpm --filter @friday/web typecheck test build` ผ่าน
