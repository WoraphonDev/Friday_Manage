# ผลทดสอบระบบและตรวจซ้ำงานแก้ไข — 6 พฤศจิกายน 2026

## ผลสรุป

**Typecheck ผ่าน, production build ผ่าน และชุดทดสอบเดิมผ่าน 794 tests แต่ Bug 14 ข้อจากรายงานเดิมยังทำซ้ำได้ครบ จึงยังรับรองว่าการแก้ Bug เหล่านั้นเสร็จแล้วไม่ได้**

จุดที่ต้องแก้ก่อนคือ BUG-02: ยืนยันกับโปรเซส API จริงแล้วว่าคำขอ WebSocket ที่มี `Cookie: fm_session=%` ทำให้ API จบด้วย `URIError: URI malformed` และ exit code 1 โดยไม่ต้อง Login กระทบเฉพาะโปรเซสทดสอบพอร์ต 43101 ที่เปิดขึ้นในรอบนี้

## Snapshot และขอบเขต

- เริ่มที่ `385ba2c8fb16baed66f6f10664262963ca91de55` บน `task/W05-overview-table` ไม่มีไฟล์แก้ไขค้างตอนเริ่ม
- ครอบคลุม API ที่ checklist เสร็จทั้งหมด, Ops API และเว็บ W00/W01/W02/W06 รวมถึง W03/W04/W05 ที่ลงโค้ดแล้วแต่ยังรอเทียบภาพ Canvas
- ระหว่างทดสอบมีการ merge W05 เป็น `62c0bed` และ Claude เริ่ม/commit W07 (`a9b72d1`, ต่อด้วย `4f1bb85` Retrigger CI) จึงไม่นับผลชุดทดสอบนี้เป็นการรับรอง W07 หรืองานที่เข้ามาทีหลัง
- ไม่พบ commit แก้ Bug เดิมใน checkout ที่ใช้ตรวจ และผู้ใช้ไม่แน่ใจว่ามี branch อื่นที่แก้ไว้หรือไม่ ผลด้านล่างจึงหมายถึงโค้ดที่เข้าถึงได้ในรอบนี้เท่านั้น
- ไม่แก้โค้ดผลิตภัณฑ์ ไม่ติ๊ก checklist Task และไม่แตะงานที่ Claude กำลังทำ

## ชุดทดสอบอัตโนมัติ

| รายการ | ผล | หลักฐาน |
|---|---|---|
| Migration บนฐานว่างแยก | ผ่าน | [migrate.log](verification-2026-11-06/migrate.log) |
| `pnpm typecheck` | ผ่าน Web, DB, API และ Ops API | [typecheck.log](verification-2026-11-06/typecheck.log) |
| Web tests | 137 ผ่าน / 10 ไฟล์ | [tests.log](verification-2026-11-06/tests.log) |
| DB tests | 107 ผ่าน / 4 ไฟล์ | tests.log |
| API tests | 533 ผ่าน, 2 skipped / 34 ไฟล์ผ่าน, 1 ไฟล์ skipped | tests.log |
| Ops API tests | 17 ผ่าน / 1 ไฟล์ | tests.log |
| **รวมชุดเดิม** | **794 ผ่าน, 2 skipped** | tests.log |
| `pnpm -r --if-present build` | ผ่าน Next.js production, API SWC และ Ops API SWC | [build.log](verification-2026-11-06/build.log) |
| Rebuild เว็บสำหรับ proxy ไป API ทดสอบแยก | ผ่าน | [web-smoke-build.log](verification-2026-11-06/web-smoke-build.log) |
| Diagnostic R01–R14 จากรายงานเดิม | 14 ผ่าน = **พบพฤติกรรมผิดเดิมครบ** | [recheck.log](verification-2026-11-06/recheck.log) |

รัน `pnpm test` แบบ sequential ตาม repo พร้อม `VALKEY_URL=redis://127.0.0.1:63799` จึงครอบคลุม BullMQ/Valkey จริงด้วย queue prefix แยก ไม่ได้ข้ามกลุ่มนี้เหมือนรอบตรวจเดิม ส่วน 2 tests ที่ skipped เป็นการตรวจไฟล์แผนจริง (`REAL_PLAN_FILE`) ซึ่งไม่ได้ให้ไฟล์ต้นฉบับมาและไม่เก็บใน public repo

ใช้ฐาน `friday_codex_verify_20261106` สำหรับ suite รวม และ `friday_codex_recheck_20261106` สำหรับ diagnostic/smoke ไม่ truncate ฐานพัฒนา `friday` ข้อมูลทุกชุดเป็นข้อมูลสมมติ ไฟล์อัปโหลดของกรณีตรวจซ้ำอยู่ใน `/private/tmp/friday-verify-*`

## ทดสอบระบบที่รันจริง

เว็บใช้ Next.js production build และ API ใช้โค้ดที่ compile แล้ว โดย API ตั้ง `NODE_ENV=test` และ `QUEUE_MODE=inline` เพื่อใช้ข้อมูลสมมติ/HTTP cookie ในเครื่อง นี่เป็น local integration verification ไม่ใช่การรับรอง production deployment, HTTPS หรือ provider จริง

| Flow | ผลที่เห็นจริง |
|---|---|
| HTTP smoke สมัคร → Logout → Login → โหลด Workspace/Project/permissions | ผ่าน API proxy จริง |
| HTTP smoke เส้นทางเว็บ | 35 เส้นทางตอบ 200; ผู้ไม่ Login เข้าโปรเจกต์ได้ 307 ไป Login |
| `/dev/ui` บน production | ตอบ 404 ตามที่โค้ดกำหนดไว้ ถูกต้อง |
| Login ผ่าน Chrome | ผ่าน เข้าหน้า Home ของ Workspace ทดสอบได้ |
| Home | แสดง KPI, โปรเจกต์, Inbox และ Workload จาก API จริง |
| Project Overview | แสดง Health, KPI, กราฟ, ข้อมูลโปรเจกต์และสถานะว่าง |
| Table | แสดง Module และ Task DE-1 ที่สร้างผ่าน API จริง |
| แก้ Priority ใน Table | เปลี่ยน medium → high, มีข้อความ “บันทึก DE-1 แล้ว”; ตรวจฐานข้อมูลยืนยัน high |
| เปิด Task จาก Table | Issue Drawer แสดงรายละเอียดและ Priority “สูง” ตรงกับที่เพิ่งแก้ |
| ส่งคอมเมนต์ใน Drawer | แสดงข้อความที่ส่งพร้อมชื่อผู้ทดสอบ; ตรวจฐานข้อมูลมีคอมเมนต์หนึ่งรายการ |
| ย้ายการ์ด Kanban | To do → In progress สำเร็จ มีข้อความยืนยันและปุ่มเลิกทำ; ตรวจฐานข้อมูลยืนยัน In progress |

หลักฐาน HTTP smoke: [smoke.log](verification-2026-11-06/smoke.log) ข้อมูลบัญชีใน log เป็นบัญชีสมมติในฐานทดสอบและตัดรหัสผ่านออกแล้ว

ผล HTTP 200 ยืนยันว่า route ตอบได้เท่านั้น บางเส้นทางยังเป็น placeholder จึงไม่ถือว่าฟีเจอร์ของหน้าเหล่านั้นเสร็จ ไม่ได้เทียบภาพครบ 1440/390 px และไม่ได้ทดสอบทุก interactive flow ของทุกหน้า จึงไม่ติ๊กข้อ Canvas ของ W03/W04/W05

ระหว่างทดสอบ Chrome มี `Failed to load chunk` หลัง Claude build งานใหม่ใน `.next` เดียวกัน ตรวจพบว่า chunk มีใน `.next/static` ชุดใหม่ แต่ไม่มีใน static ของ standalone server ที่เริ่มไว้ก่อน จึงแยกสำเนา standalone + static ไป `/private/tmp/friday-verify-frozen-runtime` และรันพอร์ต 43110 พร้อมชี้ API ทดสอบ 43101 จากนั้น Kanban โหลดและย้ายงานสำเร็จ เหตุ shared build นี้ไม่ถูกนับเป็น Bug ใหม่ของผลิตภัณฑ์

## ตรวจซ้ำ Bug เดิม

รายละเอียดวิธีแก้และเกณฑ์ผ่านยังอยู่ใน [รายงาน Bug เดิม](claude-bug-review-2026-11-06.md) สถานะด้านล่างมาจากการรันกรณีเดิมซ้ำกับ checkout รอบนี้ ไม่ได้อนุมานจากชื่อ commit อย่างเดียว

| Bug | ระดับ | ผลตรวจซ้ำ | หลักฐาน |
|---|---|---|---|
| BUG-01 GitHub setup ไม่ตรวจสิทธิ์ผู้ติดตั้งต่อ installation | P1 | ยังพบ | R08 — จำลอง installation อื่นแล้วยัง bind ได้ |
| BUG-02 Realtime ปล่อย unhandled rejection | P1 | **ยังพบ และยืนยันโปรเซส API จบจริง** | R02/R14 + handshake จริงด้านล่าง |
| BUG-03 disabled user ยังใช้ API token ได้ | P1 | ยังพบ | R01 — ได้ HTTP 200 |
| BUG-04 Guest Viewer เห็น tester และ Bug ที่ซ่อน | P1 | ยังพบ | R05 |
| BUG-05 ส่งแจ้งเตือนหลังผู้รับถูก deactivated | P1 | ยังพบ | R11 — mock sender ถูกเรียก |
| BUG-06 PUT URL เดิมเขียนทับไฟล์ที่ยืนยันแล้ว | P1 | ยังพบ | R03 — ดาวน์โหลดได้เนื้อหาที่ถูกเขียนทับ |
| BUG-07 uploadToken ใช้ยืนยันซ้ำได้ | P2 | ยังพบ | R03 — ได้ file ID ใหม่จาก token เดิม |
| BUG-08 finalize upload ข้ามโควตา | P2 | ยังพบ | R04 — ขอ URL ใหม่ได้ 402 แต่ยืนยัน token เดิมได้ 201 |
| BUG-09 Guest Member ถูกบล็อก Files | P2 | ยังพบ | R06 — มี file.upload แต่ GET Files ได้ 403 |
| BUG-10 โปรเจกต์ใหม่ไม่มีกฎ Workflow เริ่มต้น | P2 | ยังพบ | R09 — ไม่มีกฎและย้าย Review โดยไม่มี Reviewer ผ่าน |
| BUG-11 pagination ประวัติแผนทำรายการหาย | P2 | ยังพบ | R10 — หน้าถัดไปว่างทั้งที่เหลือรายการ |
| BUG-12 ราคาปีไม่อิง monthly override | P2 | ยังพบ | R07 |
| BUG-13 ปิด In-app แล้ว Email หยุดด้วย | P2 | ยังพบ | R12 |
| BUG-14 Git repo list อ่านเพียงหน้าแรก | P2 | ยังพบ | R13 |

Diagnostic script ตั้ง assertions ให้ตรงกับ **พฤติกรรมผิด** ดังนั้น `14 passed` ไม่ใช่ 14 fixes ผ่าน acceptance test แต่เป็นการยืนยันว่าปัญหาเหล่านั้นยังเกิดได้ ส่วน GitHub, SMTP, LINE และผู้ให้บริการชำระเงินใน tests ใช้ mocks ไม่ได้เรียก provider จริง

### หลักฐาน BUG-02 จากโปรเซสจริง

ส่ง HTTP Upgrade ไป API ทดสอบ `127.0.0.1:43101/realtime` พร้อม header WebSocket ปกติและ `Cookie: fm_session=%` โดยไม่มี session ที่ถูกต้อง:

```text
handshake result: ECONNRESET
URIError: URI malformed
    at decodeURIComponent
    at RealtimeService.upgrade (.../dist/realtime/realtime.service.js:114:59)
    at Server.onUpgrade (.../dist/realtime/realtime.service.js:71:48)
Node.js v22.23.3
process exit code: 1
```

หลักฐาน: [ws-crash.log](verification-2026-11-06/ws-crash.log), [api-process.log](verification-2026-11-06/api-process.log), [สคริปต์ทำซ้ำ](verification-2026-11-06/ws-crash-repro.mjs.txt)

ใช้เฉพาะ API ทดสอบที่เปิดขึ้นเอง ห้ามนำกรณีนี้ไปรันกับเซิร์ฟเวอร์ที่มีผู้ใช้จริงโดยไม่มีการจัดเวลาทดสอบ

## สิ่งที่ยังยืนยันไม่ได้และงานต่อ

1. ยังยืนยันไม่ได้ว่า Claude แก้ Bug ไว้ใน branch อื่นหรือไม่ ถ้ามี commit นั้นต้องนำมาทดสอบซ้ำเฉพาะข้อที่แก้
2. สำหรับ checkout นี้ ควรส่ง BUG-01–06 กลับไปแก้ก่อน โดยเฉพาะ BUG-02 ที่ทำให้ API จบได้จากผู้ไม่ Login
3. ไม่รวม W07 และงานใหม่หลังเริ่มรอบนี้; ไม่ถือว่า build/test ผ่านครอบคลุมไฟล์ที่ถูกแก้ทีหลัง
4. ยังไม่ได้ทดสอบ Stripe/LINE/OAuth/GitHub/S3/e-Tax ของจริง, AWS, HTTPS, โหลดพร้อมกันจำนวนมาก หรือ recovery หลัง deployment
5. ไม่ได้แก้โค้ดระบบในรอบนี้ เอกสารและ logs ชุดนี้ใช้เป็นผลตรวจให้ Claude ทำ regression fixes ต่อได้
