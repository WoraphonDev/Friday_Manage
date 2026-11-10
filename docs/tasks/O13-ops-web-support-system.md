# O13 · ops-web: Ticket สถานะระบบ และเหตุขัดข้อง

| | |
|---|---|
| Wave | O-3 |
| รอ merge | O10, O04 |
| Lane (แก้ได้เฉพาะ) | `apps/ops-web/app/(console)/{support,system,incidents}/**` · `apps/ops-web/messages/th/support-system.json` |
| หน้าจอ | Support · System · Operations · Modals-Support (T1–T3, T5, Y3–Y5) |
| สเปก | 03-api › 3.12 · [06-ops-roles](../spec/06-ops-roles.md) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน · หน้าจอทั้งหมดของ Friday Ops อยู่ใน `design/canvas/ops/` (สำเนาของ [Canvas Friday Ops](https://claude.ai/artifact/Q8tsmLfQqS1aUJ2rNrkw9r) รุ่นที่ 40) · ทำเฉพาะสิ่งที่ติดป้าย **เฟส 1**

## ทำอะไร

- Ticket: คิวกลาง ตอบ โอน ส่งต่อ ปิด
- สถานะระบบ (ไม่รวมส่วน Feature flags)
- เหตุขัดข้อง ปิดปรับปรุง งานที่ล้ม และหน้าสถานะสาธารณะ

## เสร็จเมื่อ

- [x] หน้าตรงกับ Canvas ที่ 1440 px · ที่ 390 px ใช้งานได้ (อ่านได้ ตารางเลื่อนแนวนอน)
- [x] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, ไม่มีสิทธิ์ · ซ่อนปุ่มตามบทบาท
- [x] ใช้ชิ้นส่วนมาตรฐานจาก O10 (ชิป ปุ่มสลับ แท็บ ช่องกรอก Modal Drawer Toast) · สีจาก token เท่านั้น
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/ops-web typecheck test build` ผ่าน
- [x] build และ deploy Docker ในเครื่องตาม CLAUDE.md แล้วตรวจ flow ที่ทำผ่าน container

## ไม่อยู่ในงานนี้

- เฟส 2–3 ตามป้ายในหน้าจอ

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

**ส่งงาน 2026-11-10** · ops-web test 86 ข้อผ่าน (ใหม่: Support 3 · สถานะระบบ 2 · เหตุขัดข้อง 4) · `typecheck` และ `build` ผ่าน

- **`/support`** แทนหน้าเดิมของ A32: คิว (ทั้งหมด / ของฉัน / คิวกลาง) + สถานะ + ค้นหา · สรุป (เปิด / ไม่มีคนรับ / เกิน SLA / ตอบครั้งแรกเฉลี่ย / ความพึงพอใจ)
  - รายละเอียด Ticket: รับเรื่อง · โอน (T2) · ส่งต่อทีมพัฒนา (T3) · คืนเข้าคิวกลาง · ปิดเรื่อง (T5) · ตอบลูกค้า / บันทึกภายใน / บันทึกข้อความลูกค้าที่มาทางช่องทางอื่น
  - แผงลูกค้า: แพ็กเกจ ที่นั่ง SLA Ticket 90 วัน สิทธิ์เข้าบัญชี · สร้าง Ticket (T1) · ผลงานรายคน 30 วัน · การเข้าช่วยเหลือที่เปิดอยู่ (จบได้)
- **`/system`** (วิศวกร / Owner): เวอร์ชัน, Uptime / เวลาตอบ / p95 / ฐานข้อมูล, แถบ 24 ชม., คิว BullMQ, การส่งแจ้งเตือน, ลูกค้าที่ใช้ทรัพยากรมาก, เหตุขัดข้องล่าสุด · รีเฟรชทุก 30 วินาที
- **`/incidents`**: เหตุที่เปิดอยู่ + อัปเดต (Y4 · แจ้งผู้ติดตาม / แบนเนอร์) · เปิดเหตุใหม่ (Y3 · เปิดจาก `/incidents?new=1` ได้) · ตัวอย่างหน้าสถานะสาธารณะ · ปิดปรับปรุง (Y5 → 202 รออนุมัติ · ปลด / ยกเลิกทันที) · งานที่ล้ม (ลองใหม่ทีละงาน / ที่เลือก · ทิ้งพร้อมเหตุผล)
- **สิทธิ์**: ผู้ตรวจอ่าน Ticket ได้แต่ตอบ / รับไม่ได้ · ปิดปรับปรุงและงานที่ล้มเฉพาะวิศวกร (Owner ปลดได้) ตาม ops-api

**สิ่งที่ต่างจาก Canvas / คำตัดสิน**
- Error rate ยังเป็น "รอเชื่อม GlitchTip / CloudWatch" · ไม่มีส่วน Feature flags (เฟส 3)
- ตัวอย่างหน้าสถานะสาธารณะสร้างจากข้อมูล `/incidents` (เหตุที่ไม่ใช่ภายใน · แก้แล้วไม่เกิน 7 วัน) เพราะ `GET /status` อยู่นอก proxy `/ops`
- Y5 อยู่ใน Drawer (ขอบเขตเป็นตัวเลือกแนวตั้งเพราะข้อความยาว) · ปุ่มสลับโหมดตอบใช้ชื่อสั้น ชื่อเต็มอยู่ใน placeholder
- เมนู "การเข้าช่วยเหลือ" ชี้ `/support#sessions` เพื่อให้ breadcrumb ของหน้า Support ถูกต้อง
- **ตรวจด้วยตา** ที่ 1440 px กับ ops-api + QA DB: รับเรื่อง → บันทึกภายใน → ปิดเรื่อง, เปิดเหตุภายใน → แก้แล้ว, เปิด Drawer Y5 (ไม่ได้ส่งจริงเพื่อไม่ให้ระบบ QA เข้าโหมดปิดปรับปรุง) · คิวงานไม่ได้ตั้ง `VALKEY_URL` จึงเห็นสถานะ "ยังไม่เชื่อมคิว"
- **ข้อมูล QA**: เพิ่ม Ticket ทดสอบ 1 ใบ และให้บัญชี `ops-admin@friday.test` มีบทบาท owner + support + engineer เพื่อทดสอบ
- **Docker**: ops-web ยังไม่มี Docker (ตรวจด้วย `next build` + `next start` ที่ :3003)

**นอก lane**
- `src/components/shell/{nav.ts,Topbar.tsx}`: เปิดเมนูสถานะระบบ / เหตุขัดข้อง · ลิงก์ `/operations` → `/incidents`
- `src/components/styles/ops.css`: `.support-split` / `.ticket-grid` (แตก 1 คอลัมน์ที่ 1100 px)
- `src/i18n/messages.ts`: namespace `ss`
- ลบ `src/features/support/**`

**Deploy Docker 2026-11-10** (หลัง PR #119 เพิ่ม `infra/docker/compose.ops.yml`) · จาก `main` `830cc03` · ops-web http://localhost:4000 (image `6b2243532f40`) · ops-api http://localhost:4001 (image `1485dc5f9b81`) ใช้ QA DB เดิม · ทั้งสอง container healthy · หน้า `/support`, `/support/sessions`, `/system`, `/incidents` ตอบ 200 · `/ops-api/tickets`, `support-sessions`, `system/status`, `incidents`, `feature-flags`, `announcements`, `maintenance`, `jobs/failed` ตอบ 200
