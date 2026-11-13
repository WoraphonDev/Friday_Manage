# O36 · Friday Ops: ส่งบั๊กจาก Ticket ให้ทีมพัฒนา (ผูกงานใน Friday Manage)

| | |
|---|---|
| Wave | O-4 · อนุมัติหน้าจอแล้ว 12 พ.ย. 2569 |
| รอ merge | O32 · A44 (ลูกค้าเห็นสถานะใน Ticket ของฉัน) |
| Lane (แก้ได้เฉพาะ) | `apps/ops-api/src/dev-bridge/**` · `apps/ops-api/test/dev-bridge.e2e.test.ts` · `apps/ops-web/app/(console)/bugs/**` · `apps/ops-api/src/support/tickets.service.ts` (เฉพาะ `escalate`) · `apps/ops-web/app/(console)/support/SupportPage.tsx` (T3, T8 และแท็บ "รอทีมพัฒนา") |
| หน้าจอ | `design/proposals/phase3/04-bug-to-dev.html` › บอร์ด 20 · T3 (ปรับ) · T7–T11 · T13 อีเมล · T14 งานใน FM |
| สเปก | [06-ops-roles](../spec/06-ops-roles.md) · [03-api](../spec/03-api.md) (API token, Webhook) |

อ่าน [README](README.md) ก่อนเริ่ม · หน้าจอใน `design/proposals/phase3` ผู้ใช้อนุมัติแล้ว (12 พ.ย. 2569) ยึดตามไฟล์นั้น

## ทำอะไร

ของเดิม: T3 "ส่งต่อระดับ 2" เปลี่ยน Ticket เป็น `pending_dev` + บันทึกภายใน + แจ้งลูกค้า แต่ไม่มีงานจริงให้ทีมพัฒนา

- ตั้งค่าการเชื่อมต่อ (T11, Owner / วิศวกร, แตะกุญแจเมื่อเปลี่ยน token): Workspace + โปรเจกต์ FM ของทีมพัฒนา · API token สิทธิ์ `issue.write` ของบัญชีบอท (A28) · Webhook secret · จับคู่ความรุนแรง → Priority, สถานะ / resolution → การกระทำ · ปุ่มทดสอบ
- T3 ปรับ: สร้างงานใหม่ (ประเภท Bug · ป้าย `from-support` · คำอธิบายมีเลข Ticket และรหัส Workspace เท่านั้น) หรือผูกกับงานเดิม (T7 ค้นงาน Bug ในโปรเจกต์) · เตือนงานที่อาจซ้ำจากหัวข้อ · Ticket ที่ผูกงานเดิมเพิ่มบรรทัดในคอมเมนต์ของงาน
- รับ Webhook `issue.updated` ของโปรเจกต์ FM (ตรวจลายเซ็น) → อัปเดต `dev_issue_links` · ใส่ข้อความระบบภายในใน Ticket · สำรองด้วยการดึงสถานะทุก 15 นาทีถ้า Webhook หาย
- การ์ด T8 ในหน้า Ticket + แท็บ "รอทีมพัฒนา" · หน้า 20 "ส่งบั๊กให้ทีมพัฒนา" (KPI · แถบ "ขึ้น production แล้ว ยังไม่แจ้ง" · ตาราง · การเชื่อมต่อ)
- แจ้งลูกค้าว่าแก้แล้ว (T9): ทุก Ticket ที่ผูก · ข้อความแก้ได้พร้อมตัวแปร · เปลี่ยนเป็น solved (เปิดใหม่เองเมื่อตอบใน 7 วัน) · CSAT · ร่างรายการ Changelog "แก้ไข" (ถ้ามี O33) · อีเมล T13 + กระดิ่ง (ผ่าน `support.replied` ของ A44)
- ไม่แก้ / ซ้ำ (T10): ผูกไปงานที่แก้แล้ว · แจ้งพร้อมทางเลี่ยง · หรือคืนให้ Support
- ทีมพัฒนาไม่เห็นอีเมลหรือข้อมูลส่วนตัวลูกค้า · วิศวกรไม่เห็นยอดเงิน (06-ops-roles)
- **คำขอนอก lane:** ลงทะเบียน module (O01) · เมนู (O10)

## เสร็จเมื่อ

- [x] หน้าตรงกับข้อเสนอที่อนุมัติแล้วที่ 1440 px · ที่ 390 px ใช้งานได้
- [x] ครบทุกสถานะตาม M1 · ซ่อนปุ่มตามบทบาท · Audit ทุกการส่ง / ผูก / แจ้งลูกค้า
- [x] e2e test ของ ops-api ด้วย Friday Manage API จำลอง (ข้อมูลสมมติ) + component test ด้วย MSW · typecheck / test / build ผ่าน
- [x] build และ deploy Docker API + เว็บ + ops ในเครื่องตาม CLAUDE.md · ส่ง Ticket จาก :4000 → เห็นงานใน Workspace ทดสอบของ :3000 → เปลี่ยนสถานะเป็น Released → แจ้งลูกค้าแล้วเห็นใน Ticket ของฉัน

## ยังต้องตัดสินใจ

**ผู้ใช้ตัดสินแล้ว (12 พ.ย. 2569): ใช้ตามคำแนะนำทุกข้อ** · ข้อความ "แนะนำ" ด้านล่างคือคำตัดสิน

- **เก็บบั๊กใน Friday Manage ของเราเอง (โปรเจกต์ FM)** แทน GitHub Issues หรือระบบอื่น · **แนะนำ:** ใช้ Friday Manage เอง (ใช้ API token และ Webhook ที่มีอยู่ ไม่ต้องต่อระบบนอก และเป็นการใช้ของตัวเองทุกวัน) · ถ้าทีมใช้ GitHub อยู่แล้ว ให้ผูกผ่าน Git integration (A27) ของโปรเจกต์ FM
- **"ขึ้น production" ดูจากอะไร** · **แนะนำ:** เพิ่มสถานะ "Released" (หมวด Done) ใน workflow ของโปรเจกต์ FM และให้ทีมพัฒนาย้ายงานเมื่อ deploy · ไม่ต้องต่อระบบ deploy
- **แจ้งลูกค้าอัตโนมัติเมื่อ Released หรือให้ Support กด** · **แนะนำ:** ให้ Support กด (T9) ในรอบแรกเพื่อคุมข้อความ · แจ้งเตือนทีมเมื่อมีงานรอแจ้ง · เปิดอัตโนมัติภายหลังเป็นตัวเลือก
- **Webhook จาก API ลูกค้าถึง ops-api** · **แนะนำ:** ใช้ URL ภายในเครือข่าย Docker / VPS (ops-api ไม่เปิดสู่ภายนอก) + ดึงสถานะสำรองทุก 15 นาที

## บันทึกผล

ส่งงาน 12 พ.ย. 2569 · ops-api `src/dev-bridge` (module ใหม่) · ops-web `app/(console)/bugs` + T3 / T8 / แท็บ "รอทีมพัฒนา" ใน `support/SupportPage.tsx` · **ไม่มี migration ใหม่**

**Endpoint (ops-api `ops/dev-bridge/…`)** · หน้า / การ์ด: Owner · Support · วิศวกร · ส่งต่อ / ผูก / แจ้งลูกค้า: Support · ตั้งค่า: Owner / วิศวกร

| Method | Path | หมายเหตุ |
|---|---|---|
| GET | `overview` · `links?filter=open, to_notify, not_fixed, closed30` | KPI · แถบ "ขึ้น production แล้ว ยังไม่แจ้ง" · ตาราง (ชื่อ Workspace ไม่มีอีเมล) |
| GET / PUT · POST | `settings` · `settings:test` | T11 · token / secret เข้ารหัส AES-256-GCM (`OPS_SECRETS_KEY` หรือ `OPS_AUTH_SECRET`) · ตอบแค่ `tokenHint` · เปลี่ยน token / secret ต้อง reauth (401 `reauth_required`) |
| GET | `issues?q&similar=1` | T7 ค้นงาน Bug · `similar` = งานที่อาจซ้ำจากหัวข้อ Ticket |
| GET · POST · POST / DELETE | `tickets/{id}` · `tickets/{id}:escalate` · `tickets/{id}/link` | T8 · T3 (สร้างใหม่ / ผูกงานเดิม) · เปลี่ยน / ยกเลิกการผูก |
| GET / POST · POST | `links/{id}/notify` · `links/{id}:resolve` | T9 · T10 (`link_fixed` · `workaround` · `return`) |
| POST | `ops/hooks/fm` | Webhook (ไม่ใช้ session · ตรวจ `x-friday-signature` + `x-friday-timestamp` ภายใน 5 นาที) |

**คำตัดสินและสิ่งที่ต่างจากข้อความงาน**
- สถานะ "Released" เป็นข้อมูลของโปรเจกต์ FM ฝั่งทีมพัฒนา (เพิ่มสถานะหมวด Done ชื่อ Released ในหน้า Workflow ของโปรเจกต์) ไม่ใช่ schema จึงไม่ต้องมี migration · ปุ่มทดสอบ (T11) ตรวจว่ามีสถานะนี้และอยู่หมวด Done · ชื่อสถานะตั้งได้ใน `mapping.releasedStatus`
- Webhook ใช้เป็น "สัญญาณ" เท่านั้น: หาเลขงานของโปรเจกต์ FM ใน payload แล้วดึงงานจริงผ่าน API token (payload JSON ของ A25 เป็นข้อความแจ้งเตือน ไม่มีหมวดสถานะ) · ทางเดียวกับการดึงสำรองทุก 15 นาที (`poll()` ในโปรเซส ปิดด้วย `OPS_JOBS=off`)
- ตรวจลายเซ็นจาก `JSON.stringify(body)` ที่ Express แปลงแล้ว (ตรงกับที่ API ลูกค้าส่ง เพราะผู้ส่งใช้ `JSON.stringify` ไม่เว้นวรรค) · ไม่ได้แก้ `bootstrap.ts` ให้เก็บ raw body
- ไม่แก้ / ซ้ำ: สถานะหมวด `cancelled` → `wont_fix` · ชื่อสถานะมี "dup" / "ซ้ำ" → `duplicate` และอ่าน `duplicate_of_key` จาก "ซ้ำกับ FM-466" ในคำอธิบายงาน
- งานใน FM: ประเภท Bug · Label `from-support` (สร้างให้ถ้ายังไม่มี) · Priority ตาม `mapping.severityPriority` · คำอธิบายมีเลข Ticket + รหัส Workspace (`ws_` + 4 ตัวท้ายของ id) + ลิงก์ Friday Ops เท่านั้น · ผูกงานเดิม = คอมเมนต์ในงาน
- เรียก FM ก่อนแก้ข้อมูลของเรา (FM ล้ม / token ถูกยกเลิก = 502 และ Ticket ไม่เปลี่ยน) แล้วเรียก `TicketsService.escalate` เดิม (pending_dev + บันทึกภายใน + ข้อความระบบ / อีเมลถึงลูกค้า) · แก้ `escalate` เฉพาะรับ `devIssueKey` ใส่ในบันทึกภายในและ Audit
- สถานะเปลี่ยน → บันทึกภายในทุก Ticket ที่ผูก ("ระบบ · FM-482 เปลี่ยนเป็น Released 15:05 · ขึ้น production แล้ว") · ขึ้น production หรือปิดแบบไม่แก้ขณะยังมี Ticket รอ → อีเมลหัวหน้าทีม Support (`notifyLeads` ของ O22)
- แจ้งลูกค้า (T9): ข้อความตอบ (ไม่ใช่ภายใน) ในทุก Ticket ที่ยังไม่แจ้ง · ตัวแปร `{ชื่อผู้แจ้ง}` `{เลข Ticket}` `{หัวข้อ}` · solved + `cause` "แก้โดยทีมพัฒนา (FM-xxx)" · อีเมล T13 พร้อมลิงก์ `/work/{ws}/help/tickets?ticket=` · กระดิ่งในแอปมาจาก `support.replied` ของ A44 (สแกนข้อความทีมทุกนาที) · ร่าง Changelog `kind = fixed` ผูก `dev_issue_link_id`
- ทางเลี่ยง (T10) = ตอบลูกค้า + `pending_customer` + outcome `workaround` · คืน Support = outcome `returned` + Ticket กลับเป็น open · ผูกไปงานที่แก้แล้ว = ย้าย Ticket ที่ยังไม่แจ้งไปงานนั้น
- API token ใช้ scope `write` ของ A28 (ระบบไม่มี scope `issue.write` แยก)

**ต้องตั้งค่านอกโค้ด (คำขอนอก lane / I01)**
- API ลูกค้าส่ง Webhook เข้าเครือข่ายภายในไม่ได้ (กัน SSRF) จนกว่าจะตั้ง `WEBHOOK_ALLOW_PRIVATE=1` ที่ container API · Docker ในเครื่อง: `compose.api.yml` กับ `compose.ops.yml` อยู่คนละ network ใช้ `http://host.docker.internal:4001/ops/hooks/fm` ได้เมื่อเปิด `WEBHOOK_ALLOW_PRIVATE`
- ในโปรเจกต์ FM: สร้าง Webhook (รูปแบบ JSON + signing secret เดียวกับ T11) และกฎของโปรเจกต์ให้ส่ง `issue.status_changed` / `issue.updated` · สร้างบัญชีบอท + API token scope write · เพิ่มสถานะ Released (Done)
- `apps/ops-api/src/app.module.ts` ลงทะเบียน `DevBridgeModule` (O01)

**ตรวจแล้ว:** `apps/ops-api/test/dev-bridge.e2e.test.ts` 9 ข้อ กับ Friday Manage API จำลอง (HTTP ในเครื่อง): ยังไม่ตั้งค่า 409 · reauth ตอนเปลี่ยน token · token เข้ารหัส · ปุ่มทดสอบ + สร้าง Label · สร้างงาน (คำอธิบายไม่มีอีเมล / ชื่อลูกค้า) · งานที่อาจซ้ำ · ผูกงานเดิม + คอมเมนต์ · Webhook ลายเซ็นผิด / หมดเวลา / ถูกต้อง · Released จากการดึงสำรอง + แจ้งหัวหน้าทีม · วิศวกรไม่เห็นอีเมล · T9 ตัวแปร + อีเมล + Changelog + แจ้งซ้ำไม่ได้ · T10 ทั้ง 3 แบบ · ยกเลิกการผูก · token ถูกยกเลิก 502 โดย Ticket ไม่เปลี่ยน

**หน้าเว็บ (ops-web)**
- หน้า 20 `/bugs` (KPI · แถบรอแจ้ง · ตัวกรอง · ตาราง · การ์ดการเชื่อมต่อ) · Modal T3 (สร้างใหม่ / ผูกงานเดิม / เตือนงานที่อาจซ้ำ / ยังไม่ตั้งค่า = ใช้การส่งต่อแบบเดิม) · T7 ค้นและผูก · T8 การ์ดในหน้า Ticket · T9 · T10 · T11 (เปลี่ยน token แล้วได้ `reauth_required` → แตะ Security key แล้วส่งซ้ำ)
- "รอทีมพัฒนา" เป็นชิปสถานะข้างชิปเดิมของหน้า Support (หน้าเดิมใช้ชิปกรองสถานะ ไม่มีแท็บแยก)
- T3 มีช่อง requestId ให้กรอกแทนช่องติ๊ก "แนบ requestId" เพราะ API ของ Ticket ไม่มี requestId ให้เติมอัตโนมัติ · T11 ช่องโปรเจกต์เป็นรหัสโปรเจกต์ (พิมพ์) · T10 ถ้าไม่รู้งานที่ซ้ำให้กรอกเลขงานเอง
- วิศวกรเห็นหน้า 20 และการ์ด T8 แต่ไม่มีปุ่มแจ้งลูกค้า / ส่งต่อ · Support เห็น T11 แบบอ่านอย่างเดียว · การเงินไม่มีเมนู
- คำขอนอก lane: `src/components/shell/nav.ts` (เมนู "ส่งบั๊กให้ทีมพัฒนา" → `/bugs` สำหรับ Owner / Support / วิศวกร) · `src/i18n/messages.ts` (namespace `bugs`) · `SupportPage.tsx` ใช้ T3 ตัวใหม่แทนของเดิม
- ตรวจ: `bugs.test.tsx` 13 ข้อ (MSW) · `@friday/ops-web` test 185 ผ่าน · typecheck / build ผ่าน · ดูหน้า 20 และการ์ด T8 ในเบราว์เซอร์ที่ 1440 px แล้ว · ยังไม่ได้ build / deploy Docker

**ตรวจบน Docker ในเครื่อง (13 พ.ย. 2569)** · web :3000 · API :3001 · ops :4000/:4001 build จาก main `b2d1059` + งานแก้ใน PR นี้ · ฐานข้อมูล `friday_canvas_qa` เดิม (ไม่ล้าง)
- Ticket #6 (บั๊กสมมติ) → ส่งทีมพัฒนาจาก :4000 → สร้าง FM-2 → ย้ายเป็น Released → Webhook ถึง ops ภายในไม่กี่วินาที → แถบ "ขึ้น production แล้ว ยังไม่แจ้ง" → แจ้งลูกค้า (T9) → ลูกค้าเห็นสถานะ "แก้แล้ว" และขั้นความคืบหน้าใน Ticket ของฉัน
- token ที่บันทึกใน T11 (…Og1q) ถูก API ในเครื่องปฏิเสธ (`invalid_token` · ไม่ตรงกับ token ใดในฐานข้อมูลนี้) จึงทดสอบด้วยบัญชีบอทสมมติ `ops-bot-qa-1113@example.com` (Admin + สมาชิกโปรเจกต์ FM) และ token ชั่วคราว แล้วคืนค่า token เดิมและยกเลิก token ทดสอบ · ถ้าจะใช้ในเครื่องต่อต้องใส่ token ใหม่ใน T11
- 1440 px ตรงกับบอร์ด 20 · แก้ console error `ENVIRONMENT_FALLBACK` ของ `relativeTime` (ส่งเวลาปัจจุบันทุกจุดใน ops-web) · 390 px ใช้งานได้
