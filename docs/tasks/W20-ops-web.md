# W20 · หน้าเว็บหลังบ้านทีม Friday

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A32 |
| Lane (แก้ได้เฉพาะ) | `apps/ops-web/**` |
| หน้าจอ | Q3 (`design/canvas/SuperAdmin.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · 03-api › 3.12 |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- แอปแยก `apps/ops-web` (lane ทั้งโฟลเดอร์)

## เสร็จเมื่อ

- [x] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [x] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [x] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

### แอปใหม่ `apps/ops-web` (`@friday/ops-web`) · Next.js 16 แยกจาก `apps/web`

รัน: `pnpm --filter @friday/ops-web dev` → <http://localhost:3003> (ต้องเป็น `localhost` ไม่ใช่ `127.0.0.1` เพราะ WebAuthn RP ID ของ dev = `localhost`) · ops-api `pnpm --filter @friday/ops-api dev` (พอร์ต 3002) **ต้องตั้ง `OPS_WEB_ORIGIN=http://localhost:3003`** (ค่าเริ่มต้นของ ops-api คือ `http://localhost:3002` ซึ่งชนกับพอร์ตของตัวเอง — Security key จะไม่ผ่านถ้า origin ไม่ตรง) · ตรวจ: `pnpm --filter @friday/ops-web typecheck` / `test` / `build` (ไฟล์งานเขียนว่า `@friday/web` ซึ่งน่าจะพิมพ์ผิด)

- **Proxy**: `next.config.ts` rewrite `/ops-api/:path*` → `${OPS_API_ORIGIN ?? http://127.0.0.1:3002}/ops/:path*` แบบเดียวกับ `/api/v1` ของ apps/web → cookie `fm_ops` (HttpOnly, SameSite=Strict) อยู่ใน origin เดียว ไม่ต้องเปิด CORS · browser ใส่ `Origin` ของ ops-web ให้คำขอเขียนเอง (ops-api ตรวจกับ `OPS_WEB_ORIGIN`) · ไม่มี CSRF token
- `proxy.ts` (middleware ของ Next 16): ไม่มี cookie `fm_ops` → redirect `/login` · session จริงตรวจที่ `GET ops/auth/me` ใน Shell (401 → ล้าง cache + ไป `/login`)
- เพิ่ม header `X-Frame-Options: DENY` ทุกหน้า และ `robots: noindex`
- CI: `.github/workflows/ci.yml` ใช้ `pnpm typecheck` / `pnpm test` (= `pnpm -r`) และ `pnpm -r --if-present build` → รวมแพ็กเกจนี้เอง ไม่ต้องแก้ workflow · `pnpm-lock.yaml` อัปเดตจากการเพิ่มแพ็กเกจ

### หน้า (ตาม Canvas Q3 · sidebar 5 เมนู)

| เส้นทาง | endpoint | บทบาทที่เห็นเมนู |
|---|---|---|
| `/login` | `POST ops/auth/login/options` → `startAuthentication({ optionsJSON })` → `POST login/verify { challengeToken, response }` | ทุกคน (ไม่ต้องล็อกอิน) |
| `/enroll?token=…` | `POST ops/auth/register/options { enrollToken, name }` → `startRegistration({ optionsJSON })` → `POST register/verify { challengeToken, response, name }` | พนักงานใหม่ |
| (sidebar) เพิ่ม Security key สำรอง | `register/options` โดยไม่ส่ง `enrollToken` (ใช้ session) | ทุกคน |
| `/` ภาพรวม | `GET ops/metrics` · การ์ด MRR / จ่ายเงิน (แยกตาม plan) / ทดลอง / ยกเลิก 30 วัน / รอตรวจ + "ต้องดูแลวันนี้" สร้างจากตัวเลข (รอตรวจ, ค้างชำระ, ทดลองหมด, ระงับ) ลิงก์ไป `/payments` หรือ `/workspaces?status=…` | ทุกคน |
| `/workspaces` | `GET ops/workspaces?q&plan&status` · `GET ops/workspaces/:id` · `POST …/support-sessions` · `…/extend-trial` · `…/discount` · `…/change-plan` · `…/suspend` · `…/resume` | ทุกคน (ปุ่มตามบทบาท) |
| `/payments` | `GET ops/payments?status=` · ลิงก์ `payments/:id/slip`, `wht-certificates/:id/file` · `POST payments/:id/confirm` / `reject` · `POST wht-certificates/:id/confirm` / `reject` | finance |
| `/support` | `GET ops/support-sessions` · `POST support-sessions/:id/end` | support |
| `/flags` | `GET/POST/PATCH/DELETE ops/feature-flags` · `PUT/DELETE feature-flags/:id/overrides/:workspaceId` · `GET/POST/PATCH/DELETE ops/announcements` · `POST announcements/:id/publish` | admin |

- **บทบาท** (จาก `ops/auth/me`): `src/lib/roles.ts` `can(role, need)` เลียนกฎ `@Roles` ของ ops-api (admin ผ่านทุกข้อ) — ซ่อนเมนู/ปุ่ม: ขยายทดลอง + ฟอร์มเข้าช่วยเหลือ = support · ส่วนลด / เปลี่ยนแพ็กเกจ = finance · ระงับ / เปิด, flag, ประกาศ = admin · จบ session ของคนอื่น = admin · เปิด URL ของหน้าที่ไม่มีสิทธิ์ตรง ๆ ได้หน้า "ไม่มีสิทธิ์" (ไม่เรียก API) · ถ้า ops-api ตอบ 403 `forbidden` แสดงหน้าไม่มีสิทธิ์พร้อมบทบาทจาก `details.need`
- **สถานะ M1** ทุกหน้า: skeleton ตอนโหลด, EmptyState, ErrorState พร้อม `รหัสอ้างอิง` (อ่าน `error.requestId` ใน body หรือ header `x-request-id`), error ในฟอร์ม/Dialog แสดงในที่ (InlineError + requestId)
- แถบสีส้ม "คุณกำลังเข้าใช้ในฐานะทีมช่วยเหลือ" แสดงเมื่อพนักงานคนนี้มี support session เปิดอยู่ (จาก `GET ops/support-sessions`) พร้อมปุ่ม "ออกจากบัญชีลูกค้า" = จบ session

### คำตัดสินที่เลือกเอง

- **UI kit คัดลอกมา** (`src/components/ui.tsx` + CSS ใน `src/styles/globals.css`): Button, Input, Select, Textarea, Pill, Dialog (Radix), Toast, Loading / Empty / Error / Forbidden — ชื่อคลาสเดียวกับ W00 · เหตุผล: apps/web ไม่ใช่แพ็กเกจที่ import ได้ (alias `@/` และ namespace `common` ของตัวเอง) และ import ข้ามแอปแบบ relative ทำให้ Next build ต้องคอมไพล์ไฟล์นอกโปรเจกต์ · ไม่ใช้ Tailwind (หน้าเดียวนี้ใช้ CSS ตาม Canvas ตรง ๆ) · token สีเดียวกับ `apps/web/src/styles/tokens.css`
- ข้อความทั้งหมดอยู่ใน `messages/th/ops.json` namespace `ops` (key ไม่มี ".") · ข้อความของ UI kit อยู่ใต้ `ops.ui`
- เรียก action ด้วย path แบบ `/:id/extend-trial` (ops-api รับทั้งแบบนี้และ `:extend-trial`) เพราะ `:` ใน path ผ่าน rewrite ของ Next ไม่แน่นอน
- ผลการตรวจสลิป / 50 ทวิแสดงในแถวเดิมแบบ Canvas ("ผ่าน · ออกใบกำกับภาษีแล้ว" / "ไม่ผ่าน · แจ้งลูกค้าแล้ว" / "ไม่ผ่าน · เลิกสิทธิ์แพ็กเกจชั่วคราวแล้ว" เมื่อ `revoked`) จนกว่าจะเปลี่ยนตัวกรอง · แถว 50 ทวิมาจาก `whtCertificates` ของแต่ละ payment
- ยืนยันรับเงิน / รับ 50 ทวิกดครั้งเดียว (ตาม Canvas) · ไม่ผ่าน / ระงับ / ส่วนลด / เปลี่ยนแพ็กเกจ / ขยายทดลองเปิด Dialog ที่ต้องกรอกเหตุผล (ลูกค้าเห็นใน Audit Log) · ลบ flag กดยืนยัน 2 ครั้ง
- ประกาศ: ฟอร์มสร้างบนหน้า (ปุ่ม "ตั้งเวลาส่ง" เมื่อกรอกเวลา, "บันทึกร่าง" เมื่อไม่กรอก) + รายการพร้อม ส่งทันที / แก้ไข / ลบ สำหรับที่ยังไม่ส่ง · ช่องทาง "แบนเนอร์ + Email" = `channels: ["banner","email"]`

### ต่างจาก Canvas (เพราะ API ยังไม่มีข้อมูล)

- ตารางลูกค้า: คอลัมน์ **MRR** และ **ใช้งานล่าสุด** แทนด้วย **โปรเจกต์** และ **สร้างเมื่อ** · สมาชิกแสดงจำนวน (ไม่มี "/ ขีดจำกัด") · รายละเอียดไม่มี **Data region** · ไม่มี "ค้นหาด้วยเลขผู้เสียภาษี" · ไม่มีชื่อผู้เปิดสิทธิ์ ("โดย Somchai") — แสดงสิทธิ์สูงสุดและวันหมดแทน
- ฟอร์มเข้าช่วยเหลือ: ไม่มีระยะเวลา ("60 นาที / 30 นาที") และแถบเตือนไม่มี "เหลือ 58 นาที" เพราะ support session ไม่มีเวลาหมด · โหมดแก้ไขต้องกรอก **UUID ของผู้อนุมัติคนที่ 2** เอง (ไม่มี endpoint รายชื่อพนักงาน) · ไม่มีปุ่ม "ส่งคำขอสิทธิ์ทางอีเมล" (ไม่มี endpoint) — แสดงคำแนะนำให้ลูกค้าเปิดที่ Admin Console แทน · การ "เข้าใช้ในฐานะลูกค้า" จริง (impersonate เข้าแอปลูกค้า) ยังไม่มี — สร้าง session + Audit + อีเมลเท่านั้น
- หน้าการชำระเงิน: ไม่มีการ์ด **เอกสารภาษีที่ออกล่าสุด** (ไม่มี endpoint รายการ `tax_documents`) · ไม่มีแถว "50 ทวิยังไม่ส่ง · ส่งอีเมลเตือน" · ไม่มีการ์ด KPI "แปลงเป็นลูกค้า 38%" / "เหตุผลการยกเลิก" / "+12% จากเดือนก่อน" (metrics ไม่มี) — ใช้ "รับชำระ 30 วัน", "หมดช่วงทดลองแล้ว", "ทั้งหมด / ใหม่ 30 วัน" แทน
- หน้าการเข้าช่วยเหลือ: แสดงเฉพาะ session **ที่เปิดอยู่** (Canvas เป็นประวัติทั้งหมดรวมที่จบแล้ว) เพราะ `GET ops/support-sessions` คืนเฉพาะที่เปิด · ประวัติต่อ Workspace มีใน `workspaces/:id.supportSessions` แต่ยังไม่แสดง
- Feature flags: สถานะเป็น "ทุกคน" (defaultOn) / "N Workspace" (override ที่เปิด) / "ปิด" — Canvas มี "ภายในเท่านั้น", "Enterprise" ซึ่งไม่มีในสคีมา · ปุ่ม "สร้าง flag" เพิ่มที่หัวการ์ด
- sidebar footer: ชื่อ · บทบาท + ปุ่ม "เพิ่ม Security key สำรอง" / "ออกจากระบบ" (Canvas แสดง "Mick · Owner / 2FA ด้วย Security key")
- ฟอนต์ IBM Plex Mono ไม่ได้โหลด (ใช้ `ui-monospace` แทน)
- **ยังไม่ได้เทียบภาพที่ 1440 / 390 px** (เว้น checkbox ไว้) · layout ใช้ flex-wrap แบบ Canvas: จอแคบ sidebar อยู่บนเต็มความกว้าง ตารางลูกค้าซ่อนคอลัมน์รองที่ < 900 px

### คำขอนอก lane

- **ops-api (A32)**: (1) ใส่ `requestId` ใน body ของ error (หรือ header `x-request-id`) — ตอนนี้ไม่มี ฝั่งเว็บรองรับไว้แล้ว · (2) `GET ops/staff` (รายชื่อพนักงานสำหรับเลือกผู้อนุมัติคนที่ 2) · (3) `GET ops/support-sessions?status=all` หรือประวัติที่จบแล้ว · (4) รายการ `tax_documents` ล่าสุด · (5) เวลาหมดของ support session (60/30 นาทีตาม Canvas) · (6) ค่าเริ่มต้น `OPS_WEB_ORIGIN` ควรเป็น `http://localhost:3003` (พอร์ตของ ops-web) แทน 3002 · (7) metrics: MRR เดือนก่อน, อัตราแปลงทดลอง, เหตุผลการยกเลิก, ใช้งานล่าสุด / MRR ต่อ Workspace ใน `ops/workspaces`
- **.env.example / I01**: `OPS_API_ORIGIN` (ปลายทาง rewrite ของ ops-web) · deploy ops-web ที่ `ops.friday.app` ให้ ops-api อยู่หลัง rewrite ของโดเมนเดียวกัน หรือย้าย rewrite ไป reverse proxy (ต้องให้ `OPS_RP_ID` = โดเมนของ ops-web)

### ผล test

`pnpm --filter @friday/ops-web test` 53 ข้อ (7 ไฟล์) ใช้ MSW + mock `@simplewebauthn/browser`: login (ส่ง options → `startAuthentication({ optionsJSON })` → verify ด้วย `challengeToken` + `response`, error + requestId, ผู้ใช้ยกเลิก, อีเมลผิด, browser ไม่รองรับ) · ลงทะเบียนด้วย enrollToken / key สำรอง / โทเค็นหมดอายุ / key ซ้ำ · Shell (เมนูตามบทบาท admin / support / finance, หน้าไม่มีสิทธิ์, 401 → Login, Error + requestId, แถบ session + ออกจากบัญชีลูกค้า, logout, เพิ่ม key) · ภาพรวม (KPI, ต้องดูแล, ว่าง, โหลด, Error) · ลูกค้า (ตัวกรอง → query, `?status=` จากลิงก์, ว่าง, รายละเอียด, support session read / write + ผู้อนุมัติ + error, grant อ่านอย่างเดียว / ไม่เปิด, ขยายทดลอง, ส่วนลด, เปลี่ยนแพ็กเกจ, ระงับ + 409 + requestId, เปิดอีกครั้ง, ปุ่มตามบทบาท, Error) · การชำระเงิน (สลิป + 50 ทวิ + ลิงก์ไฟล์, ยอดไม่ตรง, ยืนยัน, ไม่ผ่าน + revoked, 50 ทวิ รับ / ปฏิเสธ + error, ตัวกรองสถานะ, ว่าง, 403 `details.need`, support เปิดตรง ๆ) · การเข้าช่วยเหลือ (รายการ, จบ, ซ่อนปุ่มของคนอื่น, ว่าง) · flag (รายการ, สร้าง + validation error, PATCH, override PUT / DELETE, ลบ 2 ขั้น, ว่าง, Error) · ประกาศ (สร้างตั้งเวลา, ส่งทันที, แก้ไข, ลบ) · `typecheck` และ `build` ผ่าน
