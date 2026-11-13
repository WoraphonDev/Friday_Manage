# A44 · API: ศูนย์ช่วยเหลือ และ Ticket จากในแอปลูกค้า

| | |
|---|---|
| Wave | O-4 · อนุมัติหน้าจอแล้ว 12 พ.ย. 2569 |
| รอ merge | O32 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/help/**` (module ใหม่ · รวม Ticket ของลูกค้า) · `apps/api/test/help.e2e.test.ts` |
| หน้าจอ | `design/proposals/phase3/03-help-center.html` › X1–X6 · `04-bug-to-dev.html` › T12 |
| สเปก | [05-business-metrics](../spec/05-business-metrics.md) · migration 0018 (Ticket จากในแอปเขียนผ่าน SYSTEM_DB) |

อ่าน [README](README.md) ก่อนเริ่ม · หน้าจอใน `design/proposals/phase3` ผู้ใช้อนุมัติแล้ว (12 พ.ย. 2569) ยึดตามไฟล์นั้น

## ทำอะไร

บทความ (ไม่ต้องเข้าสู่ระบบสำหรับบทความ "ทุกคน")
- `GET help/categories` · `GET help/articles?category&q` (ค้นด้วย PostgreSQL FTS ภาษาไทย + คำค้นเพิ่ม · แบบเดียวกับ A22) · `GET help/articles/{slug}` · `GET help/articles?route=gantt` (แนะนำตามหน้า X4)
- `POST help/articles/{slug}:feedback` (ช่วยได้ / ไม่ช่วย + ข้อความ) · บันทึกคำค้นที่ไม่พบ (ตัดอีเมล / เบอร์โทรออก · ไม่เก็บผู้ค้น)
- จำกัดอัตราเรียกของ endpoint ที่ไม่ต้องเข้าสู่ระบบ

Ticket ของลูกค้า (ตารางเป็น `ops_only` จึงเขียน / อ่านผ่าน SYSTEM_DB โดยกรองด้วยผู้ใช้หรือ Workspace ที่ตรวจสิทธิ์แล้ว · เขียนเหตุผลในคอมเมนต์)
- `POST w/support/tickets` (หัวข้อ หมวด ผลกระทบ รายละเอียด ไฟล์แนบ บริบทหน้า + requestId ล่าสุด) · ช่องทาง `in_app` · คำนวณ SLA ตามกฎของ O22 · อีเมลยืนยันพร้อมเลข · ถ้าติ๊กเปิดสิทธิ์เข้าบัญชี ให้ใช้ endpoint ตั้งค่าที่มีอยู่
- `GET w/support/tickets?scope=mine|workspace` (workspace เฉพาะ Owner / Admin) · `GET w/support/tickets/{id}` **ไม่คืนข้อความภายใน** · `POST …/{id}/messages` · `POST …/{id}:close` · `POST …/{id}:reopen`
- สถานะที่ลูกค้าเห็น: open → "รอทีมตอบ" · pending_customer → "รอคุณตอบ" · pending_dev → "ส่งทีมพัฒนาแล้ว" · solved · closed
- เหตุการณ์ต่อท้าย `EventType`: `support.replied` (ให้ A23 ส่งเข้ากระดิ่ง + อีเมล) · `support.ticket_created`
- Guest เปิด Ticket ไม่ได้ (403 พร้อมข้อความให้ถามผู้เชิญ)

## เสร็จเมื่อ

- [x] e2e test ด้วยข้อมูลสมมติ: ค้นภาษาไทย · บทความเฉพาะผู้เข้าสู่ระบบ · ร่างไม่หลุด · Ticket ไม่หลุดข้าม Workspace · ข้อความภายในไม่หลุดถึงลูกค้า · Guest
- [x] `pnpm typecheck` / `pnpm --filter @friday/api test` ผ่าน
- [x] build และ deploy Docker API (`compose.api.yml`) และ ops (ให้เห็น Ticket ใหม่ในหน้า Support) ด้วยฐานข้อมูลเดิม

## ยังต้องตัดสินใจ

**ผู้ใช้ตัดสินแล้ว (12 พ.ย. 2569): ใช้ตามคำแนะนำทุกข้อ** · ข้อความ "แนะนำ" ด้านล่างคือคำตัดสิน

- **ลูกค้าตอบ Ticket ทางอีเมลได้ไหม** (ต้องมีอีเมลขาเข้า) · **แนะนำ:** รอบแรกตอบในแอป + อีเมลแจ้งพร้อมลิงก์ · รับอีเมลขาเข้าเมื่อเลือกผู้ให้บริการอีเมลจริงใน I01
- **Owner / Admin เห็น Ticket ของทั้ง Workspace** · **แนะนำ:** เห็น (ช่วยตอนคนแจ้งลาออกหรือไม่อยู่) ยกเว้น Ticket หมวดบัญชีส่วนตัว

## บันทึกผล

ส่งงาน 12 พ.ย. 2569 · module `apps/api/src/help` (ลงทะเบียนใน `app.module.ts`) · ไม่มี migration ใหม่ (ใช้ตารางของ O32 / 0033)

**Endpoint** (ทุกตัวอยู่ใน `openapi.json` แล้ว)

| Method | Path | หมายเหตุ |
|---|---|---|
| GET | `help/categories` | ไม่ต้องล็อกอิน · จำนวนบทความที่ผู้อ่านเห็น |
| GET | `help/articles?q&category&route&sort&limit&suggest&locale` | ค้น / ตามหมวด / แนะนำตามหน้า (`fallback: true` = ไม่มีบทความผูก ใช้ยอดนิยมแทน) / ยอดนิยม 30 วัน · `suggest=1` ไม่นับสถิติ |
| GET | `help/articles/{slug}?track=0` | บทความ + `related` 3 รายการ · นับยอดอ่านผ่าน `app.record_help_view` |
| POST | `help/articles/{slug}:feedback` (หรือ `/feedback`) | `{ helpful, comment? }` · ไม่เก็บผู้โหวต |
| GET / POST | `w/{ws}/support/tickets` | `scope=mine\|workspace` · ตอบพร้อม `openMine`, `canContact`, `canViewWorkspace`, `plan`, `sla` สำหรับหัวฟอร์ม X5 และ X1 |
| POST | `w/{ws}/support/attachments` | `{ name, size ≤ 10 MB, mime }` → ลิงก์ PUT + `uploadToken` (ส่งกลับมาใน `attachments: [{ uploadToken }]` สูงสุด 5 ไฟล์) |
| GET | `w/{ws}/support/tickets/{id}` | ไม่มีข้อความ internal · พนักงานแสดงเป็น `author: 'staff'` ไม่มีชื่อ · ไฟล์มีลิงก์ดาวน์โหลด 5 นาที |
| POST | `w/{ws}/support/tickets/{id}/messages` · `{id}:close` · `{id}:reopen` | |

**คำตัดสินและสิ่งที่ต่างจากข้อความงาน**
- ค้นด้วย ILIKE ทีละคำบน `search_text` (GIN pg_trgm ของ O32) แทน FTS: ทุกคำต้องตรง · ไม่มีบทความตรงครบ = ใช้ที่ตรงอย่างน้อยครึ่งหนึ่งของคำ (`partial: true`) · ส่ง `terms` ให้เว็บไฮไลต์ · คำค้นเพิ่มของทีม (`keywords`) อยู่ใน `search_text` จึงค้น "xlsx" เจอบทความ Excel
- จำกัดอัตราเรียกต่อ IP ในหน่วยความจำ (`HelpRateLimit`): อ่าน 120 / นาที · โหวต 20 / นาที · ตอบ 429 + `Retry-After`
- SLA และการแจกงานตามกฎ O22: ops-api เป็นแอปแยก import ไม่ได้ จึงคัดตรรกะ `route` / `due` / `BusinessClock` มาไว้ที่ `help/routing.ts` (คอมเมนต์บอกให้แก้คู่กัน)
- ผลกระทบ (`impact`): `team` / `blocked` ยกความสำคัญขั้นต่ำเป็น `high` · ไม่ตั้ง `urgent` จากฝั่งลูกค้า เพราะเปลี่ยน SLA เป็น 24 ชม. ทุกวัน (ให้ทีมตั้งเอง)
- บริบทหน้า / requestId / ผลกระทบ / บทความที่แนบ เก็บใน `support_ticket_messages.attachments` ของข้อความแรก (`kind: context | article | file`) ไม่ต้องเพิ่มคอลัมน์
- Owner / Admin เห็น "ทั้ง Workspace" ยกเว้นหมวด `account` ของคนอื่น และตอบแทนได้ · สมาชิกขอ `scope=workspace` ได้ 403
- ลูกค้าปิดเรื่องเอง = `closed` (ไม่ใส่สาเหตุแทนทีม) · เปิดใหม่ได้ภายใน `reopenDays` (O22, ค่าเริ่มต้น 7 วัน) นับจาก `solved_at` หรือ `closed_at` · เรื่องที่ `pending_dev` ตอบแล้วคงสถานะเดิม
- ลูกค้าเห็นว่า "ส่งทีมพัฒนาแล้ว / แก้แล้ว" จาก `dev_issue_tickets` (O36) หรือสถานะ `pending_dev` · ไม่ส่งเลขงาน FM
- `support.replied`: คำตอบของทีมเขียนโดย ops-api (อีกโปรเซส ส่งอีเมลเองแล้ว) จึงให้ `SupportRepliesJob` สแกนข้อความ staff / system ที่ไม่ใช่ภายในทุกนาที แล้วเขียนกระดิ่งผ่าน `Notifier` (dedupe ต่อข้อความ) และ publish `support.replied` · โหมดคิว inline (Docker ในเครื่อง) ตั้งเวลาในโปรเซสเอง
- เปิดสิทธิ์เข้าบัญชีในฟอร์ม X5 ใช้ `PUT w/support-access` เดิม (Owner เท่านั้นตาม A31)
- ไฟล์แนบใช้ storage driver เดิม (staging → ยืนยันตอนส่ง Ticket) ใต้ key `support/{workspaceId}/…`

**คำขอนอก lane**
- `core/events.ts` เพิ่ม `support.ticket_created`, `support.replied` ต่อท้าย union · `app.module.ts` ลงทะเบียน `HelpModule` (ไม่มี module ว่างรอไว้)
- `common/tenant.ts`: ยังไม่ได้เพิ่ม `support/` ใน `SUSPENDED_ALLOWED` · Workspace ที่ถูกระงับแบบอ่านอย่างเดียวจึงอ่าน Ticket ได้แต่เปิด / ตอบไม่ได้ (ควรเพิ่มให้ติดต่อทีมได้)
- หน้า Ticket ของ ops (T5) ยังไม่แสดงไฟล์แนบ / บริบทหน้าจาก `attachments` ของข้อความลูกค้า

**ตรวจแล้ว:** `apps/api/test/help.e2e.test.ts` 16 ข้อ (ค้นภาษาไทย · เฉพาะผู้เข้าสู่ระบบ · ร่างไม่หลุด · rate limit · Ticket ไม่หลุดข้าม Workspace / ข้ามคน · ข้อความภายในไม่หลุด · Guest · ไฟล์แนบ · เปิดใหม่ / ปิด · กระดิ่ง support.replied) บนฐาน `friday_s_help` · `pnpm --filter @friday/api test` 702 ผ่าน (3 ข้อของ automation / สรุปประจำวันล้มเฉพาะตอนรันทั้งชุดตามเวลา รันไฟล์เดี่ยวผ่าน · ไม่เกี่ยวกับงานนี้) · `openapi.json` สร้างใหม่ · ยังไม่ได้ build / deploy Docker

**ตรวจบน Docker ในเครื่อง (13 พ.ย. 2569)** · web :3000 · API :3001 · ops :4000/:4001 build จาก main `b2d1059` + งานแก้ใน PR นี้ · ฐานข้อมูล `friday_canvas_qa` เดิม (ไม่ล้าง)
- ลูกค้าส่ง Ticket #5 จากฟอร์มในแอป → เห็นในหน้า Support ของ :4000 · Ops ตอบ → ลูกค้าเห็น "ทีม Friday" และสถานะ "รอคุณตอบ" · ค้นบทความภาษาไทยผ่าน `help/articles?q=` เจอบทความที่เพิ่งเผยแพร่
