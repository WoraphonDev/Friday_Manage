# W10 · สมาชิกโปรเจกต์ + Workload และสมาชิก Workspace

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A04, A08, A14 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/w/[ws]/p/[key]/members/**` · `apps/web/app/w/[ws]/members/**` · `apps/web/messages/th/members-workload.json` |
| หน้าจอ | 7 (`design/canvas/Members.dc.html`) · H (`design/canvas/WorkspaceMembers.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · 03-api › 3.2, 3.5 แถว `p/members` |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- Workload รายสัปดาห์ต่อคน (MD / ชั่วโมง), เกิน capacity, เชิญหลายอีเมล, ลิงก์เชิญ, เปลี่ยน Role, ปิดการใช้งาน + โอนงาน (P3)

## เสร็จเมื่อ

- [x] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [x] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [x] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

### หน้าที่เพิ่ม

| Route | ใช้ API | หมายเหตุ |
|---|---|---|
| `/w/[ws]/p/[key]/members` (7 · Members + Workload) | `GET p/my-permissions` · `GET p` · `GET p/workload?from&to&group=day\|week\|month&unit=md\|hour\|count&position&moduleId` · `GET p/form-options` (ตัวเลือก Module) · `GET/POST/PATCH/DELETE p/members` · `GET/POST w/invitations` · `POST w/invitations/:id/resend\|revoke` · `GET w/members` · `GET issues/:key` + `PUT issues/:key/assignees` (If-Match) | แถบย่อย Workload / Members (n) / Invitations (n) เป็น anchor ในหน้าเดียวตาม Canvas · **Workload**: Day / Week / Month + เลื่อนช่วง ‹ › (Week = 8 สัปดาห์จากสัปดาห์นี้), วัดจาก MD / ชั่วโมง / จำนวนงาน, ตำแหน่ง, Module · KPI 5 ใบ (Capacity ทีมสัปดาห์นี้, มอบหมายแล้ว + Utilization, Overloaded + รายชื่อ %, งานยังไม่มี BA → Table, คำนวณไม่ได้แยกไม่มีวัน / ไม่มี MD) · กราฟแท่งรายคนต่อช่วง สี < 80% / 80–100% / เกิน capacity + เส้นประ capacity + เฉลี่ยต่อคน + แถวรวมทั้งทีม · คลิกแท่ง = รายละเอียดช่วงพร้อมรายการงาน (ลิงก์ `?issue=KEY`) และเปลี่ยนผู้รับผิดชอบได้ทันที (ต้องมี `issue.edit`) · **Members**: ค้นหา, Owner / Guest / ปิดการใช้งาน, Capacity ชม. + MD, Open / Overdue, สัปดาห์นี้ x/5 MD (จาก Workload ช่วงเริ่มต้น ใช้ query key เดียวกัน), วันที่เข้าร่วม · เปลี่ยน Project role ในแถว · ⋯ = แก้ตำแหน่ง / Capacity และนำออกพร้อมโอนงาน (P3, `reassignTo`) · ไม่มี `canManage` = ไม่มีช่อง Role และ ⋯ · **Invite**: หลายอีเมลคั่นด้วย , · Role · Capacity · Pending invitations ของโปรเจกต์นี้พร้อม Resend / Cancel · การ์ดสิทธิ์ของแต่ละ Role |
| `/w/[ws]/members` (H · Workspace members) | `GET w/members` · `GET w/invitations` · `GET w/usage` (Seats) · `GET p/members` ของทุกโปรเจกต์ใน shell · `PATCH w/members/:userId` · `GET w/members/:userId/handover` · `POST w/members/:userId/deactivate\|reactivate` · `POST w/invitations` · `POST w/invitations/:id/resend\|revoke` · `POST w/invite-links` · `GET issues/:key` + `PUT issues/:key/assignees` | KPI Active / รอตอบรับ / ปิดการใช้งาน / Seats ที่ใช้ (แถบ) · แท็บ ทั้งหมด / Active / รอตอบรับ / ปิดการใช้งาน พร้อมจำนวน · ค้นหาชื่อ-อีเมล, Role, โปรเจกต์ · ตารางรวมสมาชิก + คำเชิญที่รอ (คำเชิญมี Resend / Cancel ในแถว) · เปลี่ยน Workspace role ในแถว (Owner เท่านั้นเห็นตัวเลือก Owner, แก้ตัวเองไม่ได้, Admin แก้ Owner ไม่ได้) · ⋯ = **ปิดการใช้งาน + โอนงาน (P3)**: แสดงงานค้างจาก handover, โปรเจกต์ที่เป็น Owner, เลือกคนรับงานต่อ แล้วโอนทีละงาน → `deactivate` · คนที่ปิดแล้ว = เปิดใช้งานอีกครั้ง · **Dialog เชิญ**: อีเมลแบบ chip (Enter / , / วางหลายอีเมล, ผิดรูปแบบเป็นสีแดง + ข้อความ), Workspace role แบบการ์ด, เพิ่มเข้าโปรเจกต์ + Project role (Guest = Viewer), ตำแหน่ง, Capacity, ข้อความ, **ลิงก์เชิญ** (อายุ 1 / 7 / 30 วัน, Copy) · Member เห็นรายชื่อแต่ไม่มีปุ่มจัดการ · Guest = 403 โดยไม่เรียก API |

### คำตัดสินที่เลือกเอง / ต่างจาก Canvas

- **เชิญเข้าโปรเจกต์ (7)**: อีเมลที่เป็นสมาชิก Workspace อยู่แล้ว (เทียบกับ `GET w/members`) เพิ่มเข้าโปรเจกต์ตรงด้วย `POST p/members` เพราะ `POST w/invitations` ตอบ `already_member` แล้วไม่เพิ่มเข้าโปรเจกต์ · คนนอกส่งคำเชิญ `workspaceRole=member` + `projectKey`
- ระบบยังปิดการส่งอีเมล (A14) จึงแสดง **ลิงก์คำเชิญ** ให้คัดลอกหลังเชิญ / Resend (หน้า H คัดลอกลิงก์ใหม่ให้อัตโนมัติตอน Resend)
- **โอนงานตอนปิดการใช้งาน**: API `deactivate` ไม่โอนงานให้ จึงโอนจากหน้าเว็บทีละงาน (`GET issues/:key` เอา assignees + version ล่าสุด → `PUT assignees` ด้วย If-Match และ `planChangeReason`) เพื่อไม่ทับ Dev คนอื่นในงานเดียวกัน · งานที่โอนไม่สำเร็จแจ้ง key ใน toast แล้วยังปิดการใช้งานต่อ · โอนได้เฉพาะ 200 งานแรกที่ handover ส่งมา
- เปลี่ยนผู้รับผิดชอบในรายละเอียด Workload ใช้วิธีเดียวกัน (ไม่ได้ทำ "ลากงานไปให้คนอื่น" ตามข้อความใน Canvas)
- Dialog เชิญของหน้า H เลือกโปรเจกต์ได้ **1 โปรเจกต์** (Canvas เป็นรายการ checkbox) เพราะ `POST w/invitations` รับ `projectKey` เดียว
- คอลัมน์ "โปรเจกต์" ของหน้า H รวมจาก `GET p/members` ของโปรเจกต์ที่ผู้ใช้เห็นใน shell (1 request ต่อโปรเจกต์ · โปรเจกต์ที่โหลดไม่ได้ข้ามไป)
- Pending invitations ในหน้า 7 เห็นเฉพาะ Owner / Admin ของ Workspace (`GET w/invitations` ต้องมี `ws.members.manage`) · คนที่มีแค่ `project.invite` เชิญได้แต่ไม่เห็นรายการ
- ปุ่ม Day ใน Canvas ไม่ทำงาน แต่ API รองรับจึงเปิดใช้ (2 สัปดาห์) · Month = 2 เดือนนับจากเดือนนี้ · กดปุ่มช่วงวันที่ = กลับมาช่วงปัจจุบัน
- ส่วนหัวโปรเจกต์ / ปุ่ม Invite บนหัวหน้าเป็นของ shell (W00) · ปุ่ม "สิทธิ์ของแต่ละ Role" เลื่อนไปการ์ดสิทธิ์ด้านล่าง
- แถวคำเชิญในหน้า H แสดง Role เป็นข้อความ + ปุ่ม Resend / Cancel แทน ⋯ (API ไม่มีแก้ Role ของคำเชิญ)

### คำขอนอก lane

- **A14**: `GET w/members` ควรส่งโปรเจกต์ของแต่ละคน (คอลัมน์ / ตัวกรองโปรเจกต์ของหน้า H) · `deactivate` ควรรับ `reassignTo` แล้วโอนงานฝั่ง server ใน transaction เดียว (ตอนนี้หน้าเว็บโอนทีละงาน) · `POST w/invitations` เมื่ออีเมลเป็นสมาชิก Workspace อยู่แล้วและมี `projectKey` ควรเพิ่มเข้าโปรเจกต์ให้เลย · รับหลายโปรเจกต์ต่อคำเชิญ
- **A04 / A14**: `GET p/invitations` สำหรับคนที่มี `project.invite` (สเปก 03-api หน้า 7) · ตอนนี้ใช้ `GET w/invitations` แล้วกรอง `projectId`

### ผล test / ตรวจ

`src/lib/members-workload.test.tsx` 15 ข้อ (MSW): Workload ค่าเริ่มต้น + KPI + เกิน capacity + รายละเอียดช่วง, เปลี่ยนหน่วย / รายเดือน / ตำแหน่ง / Module / เลื่อนช่วง, ย้ายงาน (assignees ล่าสุด + If-Match), ว่าง / Error + requestId / 403, กำลังโหลด / Guest Viewer · Members: ตาราง + เปลี่ยน Role, แก้ Capacity + นำออกพร้อมโอนงาน, ไม่มีสิทธิ์ซ่อนปุ่ม, เชิญหลายอีเมล (สมาชิกเดิมเพิ่มตรง + ลิงก์ + อีเมลผิดรูปแบบ), Resend / Cancel + Member ไม่เห็นรายการ · หน้า H: KPI / แท็บ / โปรเจกต์ / ตัวกรอง, เปลี่ยน Workspace role + Resend, Dialog เชิญ (chip, Guest, โปรเจกต์, ลิงก์เชิญ), ปิดการใช้งาน + โอนงานแล้วเปิดใหม่, Member / Guest / Error · `pnpm --filter @friday/web typecheck test build` ผ่าน (web 209 test หลัง rebase)

**ยังไม่ได้เทียบภาพกับ Canvas ที่ 1440 / 390 px**

### เชิญสมาชิกเป็น Modal — 2026-11-07

- **ต่างจาก Canvas 7 โดยตั้งใจ** (ผู้ใช้เลือก): ฟอร์ม Invite ไม่ฝังในหน้า Members แล้ว · ปุ่ม Invite ที่หัวโปรเจกต์เปิด Modal ทับหน้าปัจจุบันจากทุกแท็บ ไม่พาไปแท็บ Members · ใช้รูปแบบเดียวกับ Invite ของ Workspace (H)
- Modal: อีเมลหลายรายการ, Role พร้อมคำอธิบายใต้ช่อง, Capacity · ข้อความผิดพลาดขึ้นหลังกดส่งเท่านั้น · มีลิงก์เชิญต้องส่งต่อเองจึงค้าง Modal ไว้ให้คัดลอก
- แท็บ Invitations เหลือรายการคำเชิญที่รอ (Resend / Cancel) + ปุ่ม + Invite · การ์ด "สิทธิ์ของแต่ละ Role" ย้ายเป็น popover จากปุ่มในหัวตาราง Members
- ไฟล์: `src/features/project-invite/` (ใช้ทั้ง ProjectShell และหน้า Members) · คำขอนอก lane: W00 `project-shell.tsx`
