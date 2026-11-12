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

- [ ] e2e test ด้วยข้อมูลสมมติ: ค้นภาษาไทย · บทความเฉพาะผู้เข้าสู่ระบบ · ร่างไม่หลุด · Ticket ไม่หลุดข้าม Workspace · ข้อความภายในไม่หลุดถึงลูกค้า · Guest
- [ ] `pnpm typecheck` / `pnpm --filter @friday/api test` ผ่าน
- [ ] build และ deploy Docker API (`compose.api.yml`) และ ops (ให้เห็น Ticket ใหม่ในหน้า Support) ด้วยฐานข้อมูลเดิม

## ยังต้องตัดสินใจ

**ผู้ใช้ตัดสินแล้ว (12 พ.ย. 2569): ใช้ตามคำแนะนำทุกข้อ** · ข้อความ "แนะนำ" ด้านล่างคือคำตัดสิน

- **ลูกค้าตอบ Ticket ทางอีเมลได้ไหม** (ต้องมีอีเมลขาเข้า) · **แนะนำ:** รอบแรกตอบในแอป + อีเมลแจ้งพร้อมลิงก์ · รับอีเมลขาเข้าเมื่อเลือกผู้ให้บริการอีเมลจริงใน I01
- **Owner / Admin เห็น Ticket ของทั้ง Workspace** · **แนะนำ:** เห็น (ช่วยตอนคนแจ้งลาออกหรือไม่อยู่) ยกเว้น Ticket หมวดบัญชีส่วนตัว

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน -->
