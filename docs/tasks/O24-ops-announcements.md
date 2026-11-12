# O24 · ส่งประกาศถึงลูกค้าที่เลือก

| | |
|---|---|
| Wave | O-4 |
| รอ merge | O23 |
| Lane (แก้ได้เฉพาะ) | `apps/ops-api/src/announcements/**` · `apps/ops-web/app/(console)/workspaces/**` (เลือกหลายแถว) · `apps/web/src/features/announcements/**` |
| หน้าจอ | `design/canvas/ops/` › Modals-Customers (C8 ส่งประกาศถึงลูกค้าที่เลือก) · Promotions (ส่วนประกาศ) |
| สเปก | [06-ops-roles](../spec/06-ops-roles.md) · [05-business-metrics](../spec/05-business-metrics.md) |

อ่าน [README](README.md) ก่อนเริ่ม · ทำเฉพาะสิ่งที่ติดป้าย **เฟส 2** ใน Canvas · **เริ่มเมื่อผู้ใช้สั่งเริ่มเฟส 2** (Canvas: "เริ่มเมื่อมีลูกค้าจ่ายเงินและข้อมูลการใช้งานจริงพอ")

## ทำอะไร

- เลือกหลาย Workspace ในรายชื่อลูกค้า → ส่งประกาศถึง Owner และ Admin (แสดงจำนวนคน) · ช่องทาง อีเมล / แบนเนอร์ในแอป / ทั้งสอง
- ตั้งเวลาส่ง · ดูตัวอย่างก่อนส่ง · บันทึกใน Audit และประวัติการส่ง (O23)
- แบนเนอร์ในแอปลูกค้าปิดได้ต่อคน · ไม่ส่งถึงรายชื่อไม่ส่งอีเมล

## เสร็จเมื่อ

- [x] หน้าตรงกับ Canvas ที่ 1440 px · ที่ 390 px ใช้งานได้
- [x] ครบทุกสถานะตาม M1 · ซ่อนปุ่มตามบทบาท · Audit ทุกการแก้
- [x] e2e test ของ API (ข้อมูลสมมติ) + component test ด้วย MSW · typecheck / test / build ผ่าน
- [x] build และ deploy Docker ในเครื่องตาม CLAUDE.md แล้วตรวจ flow ผ่าน container

## ยังต้องตัดสินใจ

- ไม่มี

## บันทึกผล

**12 พ.ย. 2569 · branch `task/O24-announcements`**

แก้นอก lane ที่ระบุ (จำเป็นต่อการส่งจริง): `packages/db` (migration 0030 + `docs/spec/01-entities.md` ที่ test ของ db ตรวจ), `apps/api/src/announcements` (module ใหม่ + ลงทะเบียนใน `app.module.ts`), `apps/api/src/channels` (ข้อความอีเมลประกาศ), `apps/ops-api/src/flags` (ย้าย CRUD ประกาศเดิมออก), `apps/ops-web/app/(console)/announcements` (หน้าใหม่) + `nav.ts`, `apps/web/src/components/shell/workspace-shell.tsx` (วางแบนเนอร์), `apps/web/src/test/server.ts` (handler เริ่มต้นของ shell), ไฟล์ข้อความ, `docs/spec/03-api.md`, `apps/api/openapi.json`

ฐานข้อมูล (migration 0030 `ops_announcements`)
- `announcements` เพิ่ม `title`, `created_by`, `cancelled_at`, `cancelled_by` · index ประกาศที่รอส่ง
- ตารางใหม่ `announcement_targets` (Workspace ที่เลือก · จำนวนผู้รับตอนส่ง · ข้อความแบนเนอร์ที่แทนตัวแปรแล้ว + ช่วงเวลาแสดง) · RLS: ลูกค้าอ่านได้เฉพาะ Workspace ปัจจุบัน เมื่อเป็น Owner / Admin และส่งแล้ว · ตาราง `announcements` ยังเป็นของทีม Friday อย่างเดียว (ลูกค้าอ่านไม่ได้)
- ตารางใหม่ `announcement_dismissals` (ปิดแบนเนอร์ต่อคน ต่อ Workspace · FK ไปที่ target) · RLS: อ่าน / เพิ่มได้เฉพาะแถวของตัวเอง

ops-api (`src/announcements`) · เฉพาะ Owner ของทีม
- `POST announcements/audience` นับ Workspace / คน (คนเดียวหลาย Workspace นับครั้งเดียว) / อีเมลที่จะส่ง / คนที่อยู่ในรายชื่อไม่ส่ง / Workspace ที่ไม่มี Owner / Admin · Workspace ที่ไม่พบหรือถูกลบ → 404 ทั้งคำขอ
- `POST announcements` หัวข้อ + ข้อความ (ตัวแปร `{ชื่อ Workspace}`) + ช่องทาง (อีเมล / แบนเนอร์ / ทั้งสอง) + ส่งตอนนี้หรือตั้งเวลา (อนาคต ≥ 1 นาที ≤ 365 วัน)
- ส่งจริง: จองด้วย `sent_at` กันส่งซ้ำ · ผู้รับ = Owner / Admin ที่ active และบัญชีไม่ถูกปิด ณ เวลาส่ง · Workspace ที่ถูกลบระหว่างรอไม่ได้รับ · tick ทุก 1 นาทีส่งประกาศที่ถึงเวลา (ปิดด้วย `OPS_JOBS=off`)
- อีเมล: สร้างแจ้งเตือน `ops.announcement` (`in_app = false` ไม่ขึ้น Inbox) + `notification_deliveries` ต่อคนต่อ Workspace แล้วตั้ง `resend_requested_at` ให้งาน scan ของ API ลูกค้าหยิบไปส่ง (ช่องทางเดียวกับปุ่มส่งซ้ำของ O23) จึงอยู่ในประวัติการส่ง · อีเมลในรายชื่อไม่ส่งบันทึกเป็น `suppressed` ตั้งแต่ตอนส่งและไม่ถูกหยิบ
- แบนเนอร์: เขียนหัวข้อ / ข้อความที่แทนชื่อ Workspace แล้วลง `announcement_targets` · แสดง 30 วัน (`BANNER_DAYS`) หรือจนกว่าผู้รับจะปิด
- `POST announcements/{id}/cancel` ก่อนส่ง = ไม่ส่ง · หลังส่งที่มีแบนเนอร์ = หยุดแบนเนอร์ทันที · อีเมลอย่างเดียวที่ส่งแล้ว → 409
- `POST announcements/test` ส่งอีเมลทดสอบถึงพนักงานเอง (แทนตัวแปรด้วย Workspace แรก) · ไม่ลงประวัติการส่งของลูกค้า
- `GET announcements` ประวัติ + ผลการส่งอีเมล (ส่งถึง / รอ / ไม่ส่ง / ล้ม จาก `notification_deliveries`)
- Audit: `audit_logs` ของทุก Workspace ที่ได้รับ (หมวด notify · ลูกค้าเห็นว่าทีม Friday ส่งอะไร) + `staff_audit_logs` ทุกการสร้าง / ยกเลิก / ส่งตามเวลา
- เอา CRUD ประกาศแบบเดิมของ A32 ออกจาก `flags` (ตั้ง `sent_at` อย่างเดียว ไม่เคยส่งจริง) · ส่วน "ประกาศถึงลูกค้า" ในหน้า Feature flags ก็เอาออก

API ลูกค้า
- `GET w/{ws}/announcements` แบนเนอร์ที่ยังแสดงและยังไม่ได้ปิด ล่าสุดก่อน · สมาชิกอื่นได้รายการว่าง · `POST w/{ws}/announcements/{id}/dismiss` ปิดของตัวเอง (ซ้ำได้) · ทุก query ผ่าน `TenantDb.run` (RLS)
- `channels`: ข้อความ `ops.announcement` ส่งเนื้อความเต็มแม้เปิดโหมดปลอดภัย (ไม่ใช่ข้อมูลงานของลูกค้า) · ส่งในนามระบบเสมอ ไม่ใช้ชื่อผู้ส่ง / SMTP ที่ Workspace ตั้ง · เปิดอีเมลเป็นค่าเริ่มต้น · เคารพช่วงงดส่งและสิทธิ์สมาชิกของผู้รับ ณ เวลาส่ง · ตรวจรายชื่อไม่ส่งซ้ำตอนส่ง
- OpenAPI อัปเดตแล้ว

หน้าเว็บ
- ops-web Workspaces: ปุ่ม "ส่งประกาศ" ในแถบเลือกหลายแถว (เฉพาะ Owner) → Drawer C8: หัวบอกจำนวน Workspace + "Owner และ Admin รวม N คน" · ช่องทาง · หัวข้อ / ข้อความ · ตอนนี้ / ตั้งเวลา (เวลาไทย) · ตัวอย่างอีเมลและแบนเนอร์ที่แทนตัวแปรด้วย Workspace แรก · ส่งทดสอบถึงฉัน · เตือนคนที่อยู่ในรายชื่อไม่ส่ง และ Workspace ที่ไม่มีผู้รับ
- ops-web หน้าใหม่ `/announcements` (เมนู "ประกาศถึงลูกค้า" เปิดใช้แล้ว · Owner): ประวัติ · ผู้รับ · ช่องทาง · ผลการส่งอีเมล · สถานะ · ยกเลิก / หยุดแบนเนอร์พร้อมเหตุผล · ว่าง / โหลด / error มี requestId / ไม่มีสิทธิ์
- ประวัติการส่ง (O23) แสดงเหตุการณ์ "ประกาศจากทีม Friday"
- เว็บลูกค้า `src/features/announcements`: แบนเนอร์ใต้แถบบนของทุกหน้าใน Workspace (Owner / Admin · สมาชิกอื่นไม่เรียก API) · ข้อความยาวย่อไว้ กด "อ่านต่อ" · ปุ่มปิดต่อคน (ซ่อนทันที ล้มแล้วคืน + แจ้ง) · สีจาก token สว่าง / มืด · ข้อความไทย / อังกฤษ

ต่างจาก Canvas
- Drawer กว้าง 640 px (`drawer-wide` ของชุด component) แทน 560 px
- เพิ่มส่วน "ตัวอย่างก่อนส่ง" ใน Drawer (งานกำหนด แต่ C8 ไม่มี) และแถบเตือนรายชื่อไม่ส่ง / Workspace ที่ไม่มีผู้รับ / หมายเหตุช่วงงดส่งและอายุแบนเนอร์
- แถบเลือกหลายแถวใช้แบบเดิมของ O11 (ด้านบนตาราง) แทนแถบสีเข้มด้านล่าง · เพิ่มปุ่ม "ส่งประกาศ" เป็นปุ่มแรกตาม Canvas
- ประวัติประกาศเป็นหน้า `/announcements` แยก: Canvas วางเป็นแท็บ "ประกาศถึงลูกค้า" ใน Promotions ซึ่งยังไม่มีเนื้อหาและหน้า Promotions ยังไม่ทำ (O20) · ย้ายเป็นแท็บได้เมื่อทำ O20
- แบนเนอร์ในแอปลูกค้าไม่มีใน Canvas · ใช้รูปแบบเดียวกับแบนเนอร์แพ็กเกจของเว็บลูกค้า
- ตรวจกับ markup ของ Canvas และ component test · ยังไม่ได้ถ่ายภาพเทียบใน browser

ยังไม่ทำ / ข้อจำกัด
- P2 ของ Entitlements "ส่งประกาศถึงลูกค้าที่ถูกกระทบ (C8)" ยังเป็นหมายเหตุ (lane ของ O21) · ต่อได้ด้วยการเปิด `AnnounceDrawer` พร้อมรหัส Workspace ที่กระทบ
- ส่งถึง "ลูกค้าทุกราย" ต้องเลือกทีละหน้า (ยังไม่มีเลือกทั้งหมดตามตัวกรอง) · ประกาศแบบทุกลูกค้าของ A32 เดิมไม่มีแล้ว
- ~~Workspace ที่ถูกระงับปิดแบนเนอร์ไม่ได้~~ แก้แล้ว: เพิ่ม `announcements` ใน `SUSPENDED_ALLOWED` ของ `common/tenant.ts` (test ใน `suspension.e2e.test.ts`)
- ยังไม่ deploy Docker (ผู้สั่งงาน deploy หลัง merge)

Test: `apps/ops-api/test/announcements.e2e.test.ts` 13 ข้อ · `apps/api/test/announcements.e2e.test.ts` 7 ข้อ · `apps/ops-web` C8 6 ข้อ + หน้าประกาศ 6 ข้อ (MSW) · `apps/web` แบนเนอร์ 5 ข้อ (MSW)

**ตรวจผ่าน Docker (12 พ.ย. 2569 · main c66d6da):** ops-api ส่งประกาศแบบแบนเนอร์ถึง Workspace ทดสอบ → API ลูกค้าผ่าน :3000 เห็นประกาศ → ปิดแล้วไม่แสดงอีก · Audit ลงทั้ง `audit_logs` และ `staff_audit_logs` · ops-web `/announcements` และ `/workspaces` ตอบ 200 · หยุดประกาศทดสอบแล้ว
