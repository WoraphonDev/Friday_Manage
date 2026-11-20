# O42 · Friday Ops: สรุปอนุมัติตัวเอง หลาย Workspace เวลาเข้าบัญชีลูกค้า Legal hold และเอกสารกฎหมาย

| | |
|---|---|
| Wave | O-5 (รอบ 4) · ผู้ใช้อนุมัติหน้าจอ 16 พ.ย. 2569 |
| รอ merge | O44-schema |
| Lane (แก้ได้เฉพาะ) | `apps/ops-api/src/{approvals,staff,workspaces,support/support.service.ts,privacy,legal,restore}/**` · `apps/api/src/privacy/**` · `apps/api/src/public/**` · `apps/web/src/features/plan-limits/Banners.tsx` (แบนเนอร์เอกสารกฎหมาย) + component ใหม่ใน `apps/web/src/features/legal/` · `apps/ops-web/app/(console)/{staff,workspaces,privacy,legal,support/sessions}/**` · `apps/ops-web/src/components/shell/AppShell.tsx` (แถบเข้าบัญชีลูกค้า) · test ของเรื่องเหล่านี้ · **ไม่แก้** `Announce.tsx` / announcements (O43) |
| หน้าจอ | `design/proposals/round4/03-approvals-customers-legal.html` › H1–H17 |
| สเปก | [06-ops-roles](../spec/06-ops-roles.md) ข้อ 3–5 · [01-entities](../spec/01-entities.md) › `legal_hold` `legal_notice` `ops_setting` |

อ่าน [README](README.md) ก่อนเริ่ม

## ทำอะไร

- **H1–H3:** อีเมลส่วนตัวของพนักงาน (แก้ได้เฉพาะเจ้าของ, แตะกุญแจ, รหัส 6 หลัก หมด 15 นาที, แจ้งอีเมลเดิมเมื่อเปลี่ยน, ห้ามโดเมนบริษัท) · งาน 08:00 ส่งสรุปรายการที่อนุมัติตัวเองของเมื่อวาน นับจาก `approval_requests` (1 คำขอ = 1 บรรทัด) · ไม่มีรายการไม่ส่ง · หยุดเมื่อมี Owner คนที่สอง · ส่งไม่สำเร็จบันทึก Audit และแถบแดงในหน้าพนักงาน · แถบหน้าพนักงานบอกการส่งล่าสุด / ยังไม่ตั้งอีเมล
- **H4–H7:** Workspaces: ช่องเลือกทั้งหน้า · "เลือกทั้งหมด N ตามตัวกรอง" · การเลือกข้ามหน้าเก็บเป็นรายการ id · endpoint หลายรายฝั่งเซิร์ฟเวอร์ (ตัวกรองหรือ id ≤ 1,000) ตรวจก่อนทำ (ทำได้ / ต้องอนุมัติ / ข้ามพร้อมเหตุ) แล้วคืนผลรายแถว · หน้าต่างผล + CSV + ไปคำขออนุมัติ · C3: "ใช้คูปองที่มีอยู่" (redeem คูปองจริง) หรือส่วนลดเฉพาะราย · วงเงินอ่านจากสิทธิ์จริงของพนักงาน · ป้ายระงับแสดงโหมด
- **H8–H9:** แถบเข้าบัญชีลูกค้านับถอยหลังจาก expires_at ของเซิร์ฟเวอร์ · Toast เหลือ 5 นาที · ขยายเวลา (15/30/60 นาที, รวม ≤ 2 ชม. ต่อครั้งที่เข้า, ไม่เกิน grant.until, เหตุผล, อีเมลแจ้ง Owner/Admin ลูกค้า) · งานทุก 1 นาทีปิดเซสชันที่หมดเวลา · ตารางมีเวลาหมด / ใช้ไป
- **H10–H13:** แก้บั๊กการ์ด "Workspace ที่รอลบ" (อ่านจากแหล่งเดียวกับหน้ากู้คืน) · Legal hold (ตั้ง: Owner + กุญแจ · ยกเลิก: คนที่สองอนุมัติ) งานลบถาวรทุกชนิดข้ามข้อมูลในขอบเขต (purge Workspace, ถังขยะ, log) · คำขอลบ PDPA ในขอบเขตขึ้น "รอ Legal hold" · นโยบายการเก็บข้อมูลแก้ได้ใน `ops_settings` key `retention` (สั้นลงต้องอนุมัติ, ภาษี 5 ปีล็อก) และงานลบตามนโยบายใช้ค่านี้ · ลบถาวรทันที: Ticket + ไม่มี hold + ไม่มีค้างชำระ + พิมพ์ slug + คนที่สองอนุมัติเสมอ (ใช้ logic เดียวกับงานลบตี 4)
- **H14–H17:** ออกฉบับใหม่มีส่วนแจ้งลูกค้า (ผู้รับ all / admins, เวลาส่ง, เตือน 7 วันก่อน, แบนเนอร์) · ส่งเป็นชุด 50 บันทึก `legal_notices` (ข้ามที่ตีกลับถาวร) · สถิติส่งแล้ว / ตีกลับ / ยอมรับ · API ลูกค้าส่ง `requiresAcceptance` และฉบับที่จะมีผล · แบนเนอร์ก่อนมีผลถึงผู้ใช้ทุกคน · วันมีผล: ฉบับต้องยอมรับขึ้นหน้าต่างให้ทุกคนที่เข้าใช้ · ฉบับแจ้งให้ทราบแสดงแบนเนอร์ 14 วัน

## เสร็จเมื่อ

- [x] หน้าตรงกับข้อเสนอที่ 1440 px · ใช้งานได้ที่ 390 px · ซ่อนปุ่มตามบทบาท
- [x] e2e ops-api + API ลูกค้า (สรุปรายวัน, หลายราย, หมดเวลา / ขยาย, Legal hold กันลบ, ลบทันที, แจ้งเอกสารกฎหมาย) + component test ด้วย MSW
- [x] `pnpm typecheck` และ test ของแพ็กเกจที่แก้ผ่าน
- [x] deploy Docker ในเครื่องตาม CLAUDE.md และตรวจผ่าน :4000 / :3000

## บันทึกผล

**Endpoint ใหม่ (ops-api)**
- `GET|POST staff/me/personal-email` · `POST staff/me/personal-email:verify` (H1 · เจ้าของบัญชีเท่านั้น · แตะกุญแจ · รหัส 6 หลักเก็บเป็น hash หมด 15 นาที · ห้ามโดเมนเดียวกับอีเมลงาน · แจ้งอีเมลเดิมเมื่อเปลี่ยน)
- `POST workspaces/bulk/preview|apply` (H4–H7 · id หรือตัวกรองเดียวกับ `GET ops/workspaces` · ≤ 1,000 · ผลรายแถว ทำได้ / ต้องอนุมัติ / ข้าม พร้อมเหตุผล)
- `POST support-sessions/:id:extend` (H9 · 15/30/60 นาที · รวม ≤ 2 ชม. · ไม่เกิน grant.until)
- `GET privacy/pending-deletes/:id` · `POST privacy/pending-deletes/:id:purge-now` (H13) · `GET|POST legal-holds` · `POST legal-holds/:id:release` · `GET|PUT retention` · `GET retention/estimate` · `GET legal/audience`

**งานเบื้องหลัง**
- ops-api: สรุปอนุมัติตัวเอง 08:00 (`staff/digest.service.ts`) · ปิดเซสชันเข้าบัญชีลูกค้าที่หมดเวลาทุก 1 นาที · ส่งอีเมลเอกสารกฎหมายเป็นชุด 50 ทุก 1 นาที
- API ลูกค้า: `privacy.retention-logs` 04:15 (ล้าง IP / User agent ใน audit_logs และลบ session ที่จบแล้วตามนโยบาย) · `privacy.purge-approved` ทุก 5 นาที (ลบทันทีที่อนุมัติแล้ว ใช้ logic เดียวกับงานลบตี 4)

**ทำต่างจากข้อเสนอ / ตัดสินเอง**
- นับรายการในสรุปรายวันจาก `approval_requests` (1 คำขอ = 1 บรรทัด) · กันส่งซ้ำด้วย `staff_push_notices`
- Legal hold: ทุกงานลบถาวร (ลบ Workspace, ถังขยะ, Log) ถาม `heldScope()` ใน `packages/db/src/retention.ts` · คำขอลบ PDPA ในขอบเขตขึ้น "รอ Legal hold" และแจ้งผู้ขอครั้งเดียว
- ระยะเก็บที่แก้ได้จริง (มีงานลบอ่านค่า): Workspace ที่ยกเลิก, ถังขยะเริ่มต้น, Log ระบบ, Audit ของทีม · ภาษี 5 ปีล็อก · Activity ของลูกค้าตามแพ็กเกจอยู่ใน entitlements
- ลบถาวรทันที: อยู่ใน `NO_SELF_APPROVAL` (ช่วงมี Owner คนเดียวใช้ไม่ได้ ตามคำตัดสินข้อ 4) · อนุมัติแล้วตั้ง `purge_after` = ตอนนี้ ให้งานของ API ลูกค้าลบ
- C3 "ใช้คูปองที่มีอยู่": ย้าย logic การใช้คูปองไปที่ `packages/db/src/promotions.ts` (`grantCoupon`) ใช้ร่วมกับ API ลูกค้า
- การ์ด "Workspace ที่รอลบ" อ่านจากแหล่งเดียวกับหน้ากู้คืน (แก้บั๊กค้น `deleted_at IS NULL`)
- แบนเนอร์เอกสารกฎหมายเดิมใน `Banners.tsx` ย้ายไป `apps/web/src/features/legal/` · ผู้ใช้ทุกคนเห็น (ไม่ใช่แค่ Owner / Admin)

**คำขอนอก lane**
- `apps/api/src/trash/purge.service.ts` (ข้าม Workspace ที่ติด Legal hold) · `packages/db/src/index.ts`, `promotions.ts`
- Announce.tsx (O43) ยังรับเฉพาะ id · รอ O43 เพิ่ม `filter` แล้วส่งตัวกรองจาก Workspaces

**Test** (ฐาน friday_o42): ops-api 227 ผ่าน / 1 ข้าม · ops-web 237 · api 795 ผ่าน / 7 ข้าม · web 715 · db 167 · `pnpm typecheck` ผ่านทุกแพ็กเกจ

**ตรวจผ่าน Docker (20 พ.ย. 2569 · main d42078d):** ops-web / ops-api deploy จาก main ที่ :4000 / :4001 · container healthy · ตรวจด้วยพนักงานสมมติ (ลบแล้ว)
- `POST ops/workspaces/bulk/preview` (ขยายทดลอง) คืน ok / ต้องอนุมัติ / ข้าม ต่อราย · `GET ops/privacy/legal-holds` · `GET ops/approvals` · `GET ops/legal/documents` 200 · หน้า `/workspaces` `/privacy` `/legal` 200
