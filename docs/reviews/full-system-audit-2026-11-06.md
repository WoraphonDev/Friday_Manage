# ตรวจ Bug / Error รอบรวม — 6 พฤศจิกายน 2569

ตรวจพบ **Bug ใหม่ที่ยืนยันด้วยฐานข้อมูลจริง 4 ข้อ** และยืนยันข้อจำกัด Daily digest เดิมอีก 1 ข้อ ทั้งหมดยังไม่ได้แก้ในรอบตรวจนี้ รายงานนี้เป็นรายการส่งต่อให้ Claude โดยไม่แก้โค้ดผลิตภัณฑ์หรือไฟล์งานที่ Claude กำลังทำ

## รุ่นและวิธีตรวจ

- Backend / schema / regression เดิม: commit `f4c44ae5ee1af42a762d3a205fa29c20959c28e7` หลัง merge การแก้ BUG-01–14
- ระหว่างตรวจ #75 เข้ามา จึงนำไฟล์ที่ commit แล้วจาก `580989a` มาตรวจ W21 ต่อด้วย รายการเปลี่ยนมีเฉพาะเว็บและเอกสาร ไม่มีไฟล์ Backend ของข้อค้นพบ N01–N04 เปลี่ยน
- สำเนาทดสอบ: `/private/tmp/friday-audit-20261106-s1` · DB: `friday_codex_audit2_20261106` · queue prefix: `friday-codex-audit2` · แยกจาก Claude เพราะ `startApp()` ล้างทุกตาราง
- รัน migration ถึง **0011** สำเร็จก่อนทดสอบ ไม่ใช้ฐานข้อมูลที่ยังไม่มีคอลัมน์ `notifications.in_app`
- เก็บผลดิบและ repro ไว้ที่ [full-system-audit-2026-11-06/](full-system-audit-2026-11-06/)
- Stripe / e-Tax / Email เป็นตัวจำลองของชุดทดสอบ ข้อมูลทั้งหมดเป็นข้อมูลสมมติ ไม่มีการชำระเงินจริง

## รายการให้ Claude แก้

P1 = กระทบสิทธิ์หรือแพ็กเกจที่ชำระแล้ว · P2 = ฟังก์ชันทำงานไม่ครบ

| ID | ระดับ | เรื่อง | ผลที่ยืนยัน | สถานะ |
|---|---|---|---|---|
| N01 | P1 | ปฏิเสธสลิปเก่า ยกเลิกสิทธิ์ของใบใหม่ที่จ่ายแล้ว | Team L จากบัตรที่ชำระสำเร็จกลายเป็น `canceled` เมื่อปฏิเสธสลิป Team M ในวันเดียวกัน | ยังไม่ได้แก้ |
| N02 | P1 | อัปโหลดสลิปใบเก่าซ้ำ ลดแพ็กเกจที่จ่ายแล้ว | Team L ที่ชำระสำเร็จถูกเปลี่ยนกลับเป็น Team M ระหว่างรอตรวจสลิปเก่า | ยังไม่ได้แก้ |
| N03 | P2 | Automation Overdue ข้ามงานหลัง 200 รายการแรกถาวร | งาน 201 ตรงเงื่อนไข แต่สแกนสองรอบได้ `ran: 0` ทั้งคู่ | ยังไม่ได้แก้ |
| N04 | P1 | บัญชีที่ปิดแล้วยังรัน Automation แก้ข้อมูลได้ | `users.disabled_at` ไม่ว่าง แต่กฎยังเปลี่ยน Priority `high → urgent` สำเร็จ | ยังไม่ได้แก้ |
| K01 | P2 | Email-only Daily digest ยังไม่ทำงาน | เปิด Email และปิด In-app → `sent: 0`, ไม่มี notification ให้ dispatcher ส่ง | ข้อจำกัดเดิม ยืนยันซ้ำแล้ว |

### N01 — ปฏิเสธใบเก่าแล้วสิทธิ์ของใบใหม่ถูกยกเลิก

ตำแหน่ง: `apps/ops-api/src/payments/ops-payments.service.ts:115–119`

ขั้นตอน:

1. สร้าง checkout A แบบโอนเงิน Team M แล้วแนบสลิป ให้แพ็กเกจเปิดชั่วคราว
2. วันเดียวกัน สร้าง checkout B แบบบัตร Team L และรับ webhook ชำระสำเร็จ ตรวจได้ว่า subscription เป็น `active / team_l`
3. Finance ปฏิเสธสลิป A

ผลจริง: `reject()` ตอบ `revoked: true` และ subscription เป็น `canceled / team_l` ทั้งที่ B จ่ายแล้ว

สาเหตุ: ใช้แค่ `currentPeriodStart === invoice.periodStart` ตัดสินว่าใบที่ปฏิเสธเป็นใบที่เปิดสิทธิ์ปัจจุบัน วันเริ่มของหลายใบในวันเดียวกันตรงกันได้ จึงไม่ใช่หลักฐานว่า A เป็นแหล่งสิทธิ์ปัจจุบัน

ควรแก้: ผูกแหล่งที่มาของสิทธิ์ชั่วคราวกับ invoice/payment ให้ระบุได้แน่นอน ล็อกและตรวจสถานะล่าสุดในธุรกรรมเดียว การปฏิเสธ A ต้องไม่เพิกถอน B ที่ชำระสำเร็จแล้ว ตรวจทั้งกรณีวันเดียวกันและใบคนละวัน

เกณฑ์ผ่าน: หลังข้อ 3 ต้องยังเป็น `active / team_l` และ `revoked` ของ A ต้องไม่อ้างว่าได้ยกเลิกสิทธิ์ B

### N02 — สลิปใบเก่าทับแพ็กเกจที่จ่ายแล้ว

ตำแหน่ง: `apps/api/src/payments/invoices.service.ts:178–191` และ `payments.service.ts:203` (`activate`)

ขั้นตอน:

1. Checkout A โอน Team M และแนบสลิป คงสถานะรอตรวจไว้
2. Checkout B บัตร Team L ชำระสำเร็จ ได้ `active / team_l`
3. แนบสลิป A อีกครั้งผ่าน `POST .../billing/invoices/{A}/slip`

ผลจริง: API รับสลิป (201) และ subscription เปลี่ยนเป็น `active / team_m`

สาเหตุ: สลิปของ invoice ที่ยังไม่ paid/void เรียก `activate()` เสมอ โดยไม่มีการตรวจว่าใบอื่นได้เปิดสิทธิ์ที่ใหม่กว่าแล้ว

ควรแก้: แยกการเก็บ/ตรวจสลิปออกจากการเลือกสิทธิ์ปัจจุบัน กำหนดกติกา invoice ที่ถูกแทนที่ และป้องกัน invoice เก่าย้อนแพ็กเกจหรือช่วงสิทธิ์ที่ชำระแล้ว ตรวจ webhook/การยืนยัน Ops ที่มาสลับลำดับด้วย

เกณฑ์ผ่าน: เก็บสลิป A ได้ตามกติกาที่เลือก แต่ต้องไม่ลด Team L ที่ชำระแล้วโดยผลข้างเคียงของสลิป A

### N03 — งาน Overdue หลังรายการ 200 ไม่เคยถึงคิว

ตำแหน่ง: `apps/api/src/automation/engine.ts:272–275`

ขั้นตอน:

1. สร้างงานยังไม่เสร็จและเลย Due 201 งาน เรียงเลข 1–201
2. งาน 1–200 เป็น Priority low ส่วนงาน 201 เป็น high
3. กฎ trigger `overdue`, condition `priority eq high`, action เพิ่ม Label
4. เรียก `scanOverdue()` สองรอบ

ผลจริง: `{ ran: 0 }` ทั้งสองรอบ งาน 201 ไม่ถูกประมวลผล แม้เป็นงานเดียวที่ตรงเงื่อนไข

สาเหตุ: `issues.slice(0, SCAN_LIMIT)` เกิดก่อนตัดงานที่เคยทำแล้วและก่อนตรวจ conditions แต่ละรอบเริ่มอ่าน 200 งานแรกเดิม ไม่มี cursor ไปส่วนที่เหลือ

ควรแก้: เลื่อน cursor/แบ่ง batch จนถึงงานที่เหลือ หรือตัด seen และตรวจเงื่อนไขก่อนใช้โควตา batch โดยยังจำกัดการใช้ทรัพยากรได้

เกณฑ์ผ่าน: งาน 201 ถูกทำหนึ่งครั้ง และสแกนซ้ำไม่ทำซ้ำ; เพิ่มกรณี 200 งานแรกมี dedupe แล้วด้วย

### N04 — Automation ของบัญชีที่ปิดยังแก้ข้อมูลได้

ตำแหน่ง: `apps/api/src/automation/engine.ts:343–349`

ขั้นตอน:

1. Owner สร้างกฎ Overdue ให้เปลี่ยน Priority ของงาน high เป็น urgent
2. ปิดบัญชีผู้สร้างด้วย `users.disabled_at = now()` โดยสมาชิก Workspace ยัง active (เงื่อนไขเดียวกับ regression BUG-03 ของ API token)
3. เรียกเครื่องยนต์ Automation

ผลจริง: `{ ran: 1 }`, Priority เปลี่ยนเป็น urgent และมีประวัติการแก้ไข

สาเหตุ: `actorFor()` ตรวจสมาชิก Workspace และ Workspace ที่ไม่ถูกลบ แต่ไม่ตรวจ `users.disabled_at` ก่อนสร้าง auth สำหรับ TenantDb การทำงานเบื้องหลังจึงข้ามเงื่อนไขที่ AuthGuard ตรวจเมื่อมี HTTP request

ควรแก้: ตรวจบัญชีผู้สร้างก่อนทำ action และตรวจการถอนสิทธิ์ล่าสุดของแต่ละ action ด้วย กฎของผู้สร้างที่ถูกปิดควรหยุด/ลง failed หรือ skipped พร้อมเหตุผล

เกณฑ์ผ่าน: บัญชีปิด → ข้อมูลงานไม่เปลี่ยน; เปิดบัญชีกลับ → ทำงานได้เมื่อยังมีสิทธิ์; แยกทดสอบจากการ deactivated สมาชิก Workspace

### K01 — Daily digest ยังผูกผู้รับกับ In-app

ตำแหน่ง: `apps/api/src/notifications/reminders.ts:128–130`

ผู้ใช้มีงานเลยกำหนดที่ได้รับมอบหมาย เปิด `digest.daily/email` และปิด `digest.daily/in_app` แล้วเรียก digest วันทำงาน `2026-11-06` ผลคือ `sent: 0` และไม่มีแถว notifications

สาเหตุ: เลือกผู้รับจาก `audience.inAppEnabled('digest.daily')` ตั้งแต่ต้น จึงไปไม่ถึงเส้นทาง `notifications.in_app = false` ที่ BUG-13 เพิ่มมา

เป็นข้อจำกัดที่ [เอกสารแก้ Bug เดิม](claude-bug-fixes-2026-11-06.md) แจ้งไว้แล้ว **ไม่นับเป็น Bug ใหม่** ควรรวมผู้ที่เปิดช่องทางอื่น แล้วกำหนด `inAppOff` เมื่อสร้างแถว และคงการตรวจ digest schedule / วันทำการ / สิทธิ์ในการเห็นงาน

เกณฑ์ผ่าน: Email-only ต้องมี notification ที่ `in_app=false` ให้ dispatcher ส่ง Email โดย Inbox ยังไม่แสดงรายการนี้

## ผลชุดทดสอบและ build

| ส่วน | ผล | หมายเหตุ |
|---|---|---|
| Migration | ผ่าน | รวม 0011 ใน DB แยก |
| Typecheck ทั้ง monorepo | ผ่าน | ทั้งฐาน f4c44ae และหลังนำ #75 มาตรวจต่อ |
| DB | 107 ผ่าน | PostgreSQL จริง |
| API | 567 ผ่าน, 2 ข้าม | 2 ข้อใช้ไฟล์แผนจริงที่ไม่ได้ให้มา; ไม่ใช้ข้อมูลจริงใน repo public |
| Ops API | 17 ผ่าน | WebAuthn จำลอง ตรวจด้วยไลบรารีจริง |
| Ops Web | 53 ผ่าน | Component/MSW |
| Web ฐาน f4c44ae, Node 26.7.0 | 404 ผ่าน, 5 ไม่ผ่าน | multipart ใน jsdom/MSW; แยกจากข้อค้นพบ N01–N04 |
| Web ฐาน f4c44ae, Node 24 | 404 ผ่าน, 5 ไม่ผ่าน | ล้มชุดเดียวกัน |
| Web หลัง #75, Node 22.23.3: 2 ไฟล์ที่เคยล้ม | 32 ผ่านทั้งหมด | รุ่น Node ตรงกับ CI; ไม่ได้แก้ setup เพื่อให้ผ่าน |
| Web หลัง #75, Node 22.23.3: ทั้งชุด | **411 ผ่านทั้งหมด** | 25 ไฟล์; รวม 2 test ใหม่ของ #75 |
| API build | ผ่าน | SWC 195 ไฟล์ |
| Ops API build | ผ่าน | SWC |
| Web / Ops Web production build | ผ่านด้วย Webpack | เว็บตรวจ build ใหม่หลัง #75 แล้วด้วย |
| Turbopack ในสำเนานี้ | ติดสภาพแวดล้อม | dependency symlink อยู่นอก root ของสำเนา; ไม่นับเป็น Bug ผลิตภัณฑ์ |
| Acceptance เพิ่ม N01–N04 และ K01 | 5 ไม่ผ่านตามเกณฑ์ที่ถูกต้อง | ยืนยันพฤติกรรมผิดทั้ง 5 ข้อ ดู `new-repro.log` |

รวมชุดทดสอบปกติของโค้ดล่าสุดที่ตรวจ: **1,155 ผ่าน / 2 ข้าม** (411 Web + 53 Ops Web + 107 DB + 567 API + 17 Ops API) รวมจากการรันแยกแพ็กเกจ ไม่รวม acceptance เพิ่ม 5 ข้อที่ยังล้ม Backend / Ops Web ตรวจด้วย Node 26 ส่วน Web ตรวจด้วย Node 22 ตาม CI ผล Node 24/26 ที่ไม่ผ่านไม่ใช่ผลบน runtime ของ CI

Error ของ Web บน Node 24/26 อยู่ที่ multipart/jsdom/MSW (`multipartFormDataParser`, File/Blob คนละ realm) การทดลองเปลี่ยน File ใน setup **เฉพาะสำเนาชั่วคราว** ทำให้สลิปผ่านแต่ Excel ยังมี Blob type error จึงย้อน setup กลับก่อนตรวจ Node 22 ไม่ได้ส่งการเปลี่ยน setup นั้นกลับเข้า repo และไม่ถือเป็นวิธีแก้ที่ยืนยันแล้ว

ชุดทดสอบปกติครอบคลุม regression แก้ BUG-01–14 และผ่าน รวม GitHub OAuth, realtime, disabled token, Guest redaction, delivery recheck, upload single-use/quota/concurrency, Guest Member, default workflow rules, pagination และราคา ทั้งนี้ BUG-13 ยังมีส่วน Daily digest ตาม K01

**ไม่ได้ใช้ repro เดิม R01–R14 เป็น acceptance:** ไฟล์นั้นตรวจพฤติกรรมผิดเดิม จึงใช้ผลล้มของมันตัดสินว่าเกิด regression ไม่ได้ อีกทั้ง `seedTeam()` รุ่นใหม่ลบ default workflow rules เพื่อคง fixture เก่า การคาดว่าทุก assertion ของ repro เก่าจะกลับขั้วจึงไม่เพียงพอ

## สิ่งที่ตรวจผ่านเบราว์เซอร์และข้อที่ยังต้องตรวจ

ตรวจใน Chrome กับเว็บ `localhost:43200` และ API `43201` ซึ่งต่อ DB audit เท่านั้น:

- Login ด้วยบัญชีสมมติ → Home แสดงข้อมูลจาก API จริง → เปิด Project Overview ได้
- หลัง #75 เมนู Workspace มีตัวเลือก ไทย / English เปลี่ยนเป็น English แล้ว shell และ Overview แสดงข้อความอังกฤษ โหลดหน้าใหม่ยังเป็น English
- ชื่อเดือนยังเป็นไทย เช่น `Due today 0 6 พ.ย. 26` ตรงกับข้อ 7–8 ที่ W21 บันทึกว่ายังไม่เสร็จ; ฟอร์มภาษาใน Profile และ metadata บางหน้ายังค้างตามข้อ 6–8
- ปิดเฉพาะแท็บ audit และ server audit หลังตรวจ ไม่หยุด server ของ Claude

| ขอบเขต | สถานะ |
|---|---|
| เทียบภาพ W03–W21 กับ Canvas ทุกหน้าที่ 1440/390 px | **ยังไม่ได้ตรวจครบ** — browser smoke ข้างต้นไม่ใช่ visual acceptance |
| GitHub install จริง | ต้องเปิด OAuth during installation และตั้ง client ID/secret ตามที่แจ้ง; suite ใช้ GitHub จำลอง ไม่มีผลยืนยัน live installation |
| Stripe/e-Tax/Email/LINE จริง | ยังไม่ได้ยืนยันกับผู้ให้บริการจริง |
| S3 จริง | ยังไม่ได้ทดสอบ storage จริง; regression อัปโหลดที่ผ่านไม่ใช่ผลตรวจ S3 production |
| ภาษาอังกฤษทุกหน้า/ทุกข้อความ | ยังไม่ปิดงาน W21; switch ใช้ได้แล้ว แต่ข้อ 6–8 ยังเหลือ |

## วิธีใช้ repro ใหม่

ไฟล์ [acceptance-repro.e2e.test.ts.txt](full-system-audit-2026-11-06/acceptance-repro.e2e.test.ts.txt) เก็บเป็น `.txt` เพื่อไม่เข้า suite อัตโนมัติ ให้คัดลอกเป็น `apps/api/test/audit-new-repro.e2e.test.ts` ใน checkout ทดสอบ แล้วตั้ง URL ทั้งสามให้เป็น **DB ทิ้งได้ตัวเดียวกันที่แยกจาก Claude** รัน migration ก่อนเสมอ และรัน:

```sh
pnpm --filter @friday/api exec vitest run test/audit-new-repro.e2e.test.ts
```

ข้อ N01–N04/K01 ในไฟล์นี้ตรวจ **พฤติกรรมที่ถูกต้อง** ปัจจุบันล้ม 5 ข้อ หลังแก้ต้องผ่านทั้ง 5 ข้อ ตรงข้ามกับไฟล์ repro เดิม เฉพาะ N01 เรียก Ops service กับฐานข้อมูลจริงโดยตรง ส่วน checkout, webhook และ slip ผ่าน HTTP ของ API จริง การส่งอีเมล Ops เป็นตัวจำลอง

ตัวช่วย `startApp()` มี TRUNCATE ทุกตาราง ห้ามชี้ฐานข้อมูลที่ Claude กำลังทดสอบหรือฐานข้อมูลที่ต้องเก็บไว้ ควรรันทั้งไฟล์เพราะข้อ N03/N04 ใช้ fixture ต่อเนื่อง แล้วนำกรณี regression ไปจัดเป็น fixture อิสระใน lane ของแต่ละ module ตอนแก้จริง
