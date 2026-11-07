# W00 · โครงเว็บ Next.js: Design system, API client, Shell, เส้นทางทุกหน้า

| | |
|---|---|
| Wave | 0 · ฐานราก (เริ่มก่อน) |
| รอ merge | — เริ่มได้เลย |
| Lane (แก้ได้เฉพาะ) | `apps/web/**` (ทั้งหมด จนกว่างานนี้ merge · หลังจากนั้นแบ่งตามตาราง "เส้นทางของหน้าเว็บ" ใน README) |
| หน้าจอ | K4 (`design/canvas/Bell.dc.html`) · M1 (`design/canvas/States.dc.html`) · Q1 (`design/canvas/WorkspaceSwitch.dc.html`) · 1 (`design/canvas/Main.dc.html`) |
| สเปก | docs/tech-stack.md · 03-api › 1. ธรรมเนียมของ API (Error, ETag/If-Match, 402, Realtime) · README ของงาน › เส้นทางของหน้าเว็บ |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `apps/web`: Next.js (App Router) + React + TypeScript strict · ชื่อแพ็กเกจ `@friday/web` · script `dev`, `build`, `typecheck`, `test` · dev proxy `/api/v1/*` → `http://localhost:3001` (cookie อยู่ origin เดียว)
- Design token จาก CSS ใน `design/canvas/*.dc.html` (สี, ตัวอักษร, ระยะ, เงา, สีสถานะ / Priority / Module) → `src/styles/tokens.css` · รองรับ 1440 px และมือถือ 390 px
- UI kit ใน `src/components/ui/`: Button, Input, Select, Combobox (เลือกคน), DatePicker (แสดงปี พ.ศ. / ค.ศ. ตาม `me.yearFormat`), Badge, StatusPill, PriorityTag, Avatar (initials + สี), AvatarStack, Tabs, Table, Drawer (ซ้อน 2 ชั้นได้), Dialog, ConfirmDialog (แบบ P3 + ปุ่มเลิกทำใน Toast), Toast, Tooltip, Skeleton, EmptyState / ErrorState / Forbidden / NotFound ตามหน้า M1
- API client `src/lib/api.ts`: `credentials: include` · ส่ง `x-csrf-token` ทุกคำขอที่แก้ข้อมูล (ดึงจาก `GET auth/csrf`) · แปลง `{ error: { code, message, details, requestId } }` เป็น `ApiError` · helper ETag / If-Match · 401 → หน้า Login แบบจำหน้าเดิม · 402 → Dialog เกินแพ็กเกจแบบทั่วไป · 409 conflict → คืนค่า `latest` ให้หน้าจอ · TanStack Query สำหรับ cache
- i18n: next-intl ภาษาไทยเป็นค่าเริ่มต้น · ข้อความแยกไฟล์ต่องาน `messages/th/<namespace>.json` (เช่น `kanban.json`) ไม่รวมไฟล์เดียว · `src/lib/format.ts`: วันที่แบบ "1 ธ.ค. 69", ช่วงวัน, Man-Day, "เลยกำหนด 3 วัน"
- Shell: `app/w/[ws]/layout.tsx` (Sidebar: Home, My Tasks, Inbox พร้อมจำนวน, Projects, + New project, Admin Console · Top bar: ช่องค้นหา + Ctrl K, ปุ่ม + New, กระดิ่ง, Avatar, ตัวสลับ Workspace Q1 จาก `GET me/workspaces`) · `app/w/[ws]/p/[key]/layout.tsx` (หัวโปรเจกต์ + แท็บ 11 แท็บตาม Canvas + ซ่อนแท็บตาม `my-permissions` และ Guest)
- สร้างทุกเส้นทางในตาราง "เส้นทางของหน้าเว็บ" เป็นหน้า placeholder (`<Placeholder task="W06" />`) และโฟลเดอร์ feature ว่าง: `src/features/issue-drawer/IssueDrawer.tsx` (project layout เปิดเมื่อ URL มี `?issue=DP-39`), `src/features/bell/Bell.tsx`, `src/features/command-palette/CommandPalette.tsx` · งานหน้าเว็บแทนที่เฉพาะไฟล์ของตัวเอง
- Test: Vitest + Testing Library + MSW · `src/test/` มี render helper (Query + i18n + router) และ fixture ของ API ที่มีอยู่แล้ว (ข้อมูลสมมติ)
- เพิ่ม `apps/web/AGENTS.md` สั้น ๆ: วิธีรัน, ตำแหน่ง UI kit, ธรรมเนียมการวางไฟล์ของงานหน้าเว็บ

## กติกาที่ต้องตรง

- หน้าตาตาม Canvas (UI v1.0.3 ล็อกแล้ว) · ไม่ออกแบบใหม่
- UI kit และ `src/lib/**` เป็นไฟล์กลาง: หลังงานนี้ merge งานอื่นเพิ่มไฟล์ใหม่ได้ แต่แก้ไฟล์เดิมได้เฉพาะงาน W00 รอบถัดไป

## เสร็จเมื่อ

- [x] `pnpm --filter @friday/web build`, `typecheck`, `test` ผ่าน
- [x] เปิดทุกเส้นทางในตารางได้ (placeholder) · ยังไม่ล็อกอินถูกพาไป `/login`
- [x] ล็อกอินกับ API จริงในเครื่องแล้วเห็น Shell + รายชื่อโปรเจกต์ใน Sidebar
- [x] Storybook ไม่ต้องมี · หน้า `/dev/ui` (เฉพาะ dev) แสดงทุก component ใน UI kit
- [x] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [x] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [x] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## ไม่อยู่ในงานนี้

- เนื้อหาของแต่ละหน้า (งาน W01–W21)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

- เพิ่ม `@friday/web`: Next.js 16.4.5 / React 19.3.1 / TypeScript strict, Tailwind + Radix primitives, TanStack Query, next-intl, Vitest / Testing Library / MSW · proxy `/api/v1` ไป `127.0.0.1:3001` (เปลี่ยนด้วย `API_ORIGIN`) เพื่อให้ session cookie อยู่ origin เดียวกัน
- ใช้สี, ตัวอักษร IBM Plex Sans Thai, ระยะ, card, control และแถบสถานะจาก Canvas ใน `tokens.css` · font เก็บในแพ็กเกจ จึง build ได้โดยไม่ต้องดึง Google Fonts · UI kit รวม form, people/date picker, table/tabs, status/priority/avatar, tooltip, dialog, Drawer สองชั้น, confirm/undo toast และสถานะ M1
- API client ส่ง cookie ทุกครั้ง, ดึง/ใช้ CSRF cookie ล่าสุดก่อน mutation (รวม FormData), รองรับ ETag/If-Match, `ApiError` + requestId/latest, 401 จำ path/query/hash ไป Login, 402 เปิด dialog ทั่วไป · cache key แยก Workspace/Project · proxy ตรวจ cookie ก่อน render และ GET /me ตรวจ session จริงอีกครั้ง
- Shell ดึง me/workspaces/projects/notification summary จาก API จริง · สลับ Workspace พร้อม role/จำนวนแจ้งเตือน, Ctrl K ค้นหา, Ctrl 1–9 สลับ Workspace, Sidebar/มือถือ, avatar, ปุ่ม New ตามสิทธิ์ · โปรเจกต์มี 11 แท็บตาม Main.dc.html; Guest Viewer เห็น Overview/Timeline เท่านั้น และเข้า URL ของแท็บที่ไม่มีสิทธิ์ได้ Forbidden
- สร้าง placeholder ทุก route ของ `apps/web` รวม catch-all ของ Admin/Settings/Billing · แยกสัญญา feature สำหรับ W02 / W04 / W16 พร้อมเปิด Drawer จาก `?issue=` หรือ `?new=1` · หน้า ops เป็นแอปแยกของ W20 ตาม lane เดิม
- ข้อความของ W00 อยู่ใน `messages/th/common.json` · server โหลด namespace JSON ใหม่อัตโนมัติเพื่อให้งานหน้าอื่นไม่ต้องแก้ไฟล์กลาง · format วันที่/ช่วงวัน/MD/overdue ใช้ Asia/Bangkok และ DatePicker ใช้ `me.yearFormat`
- `/dev/ui` แสดง UI kit และมีฟอร์มทดสอบ login เฉพาะ development (หน้า Login จริงยังเป็น placeholder W01) · production ตอบ 404 · `start` ใช้ standalone server พร้อมคัดลอก static/public assets · ตรวจ HTTP production แล้ว: หน้าแรก/CSS 200, dev UI 404, anonymous Workspace 307
- ทดสอบ API จริงผ่าน proxy ด้วยบัญชี/Workspace/โปรเจกต์สมมติ: signup → logout → login → me/workspaces/projects/permissions สำเร็จ; smoke script ตรวจ 36 URL รวม route ย่อยและ anonymous redirect · เปิด Chrome login ผ่าน dev UI แล้วเห็นรายชื่อโปรเจกต์และ 11 แท็บจริง
- ตรวจภาพ Chrome ที่ viewport 1440×1000 และ 390×844 พร้อมทดสอบเมนู Projects มือถือ · หลักฐานอยู่ `apps/web/qa/w00-shell-desktop.png`, `w00-shell-mobile.png`, `w00-ui-desktop.png` · ข้อมูลในภาพเป็นข้อมูลสมมติ
- `pnpm typecheck`, `pnpm test`, `pnpm -r --if-present build` ผ่าน: Web 31 + DB 24 + API 54 = 109 tests; ข้าม 2 tests ที่ต้องใช้ไฟล์แผนจริง · จำนวนนี้เป็นของ branch W00 ที่แยกจาก T00 ซึ่งยังเป็น PR คนละงาน
- ไม่มีคำขอนอก lane · แก้เฉพาะ `apps/web/**`, lockfile สำหรับ dependency และ checkbox/บันทึกผลของ W00
- แก้หลัง merge (Select ชนลูกศร): ปรับ `Select` ใน UI kit ให้ซ่อนลูกศรของ browser แล้ววาง Chevron เอง เว้นขวา 34px · เพิ่ม `size="small"` (36px สำหรับแถบตัวกรอง) และ `prefix` (คำนำหน้าในกล่อง ค่าเป็นตัวหนาสีหลักตาม Canvas Kanban) · `className` ของ Select ไปอยู่ที่กล่องแทน `<select>` · ตรวจภาพที่ 364 px, 1440 px และฟอร์มใน /dev/ui

### เมนู Workspace และเมนูบัญชีแบบใหม่ — 2026-11-07

- ผู้ใช้ขอให้ออกแบบใหม่ตามตัวอย่าง monday: ตัวสลับ Workspace มีค้นหา (เมื่อมีมากกว่า 4), รายการ, สร้าง Workspace, ตั้งค่า Workspace (Owner / Admin) และคีย์ลัด Ctrl 1–9
- avatar มุมขวาเป็นเมนูบัญชี (เดิมเป็นลิงก์ไป Profile): ชื่อ / อีเมล · คอลัมน์บัญชี (โปรไฟล์, การแจ้งเตือน, เวลาทำงาน, ความปลอดภัย) · คอลัมน์ Workspace (สมาชิก, นำเข้าแผน, Admin Console, แพ็กเกจ) · ภาษา / ปี และออกจากระบบย้ายมาไว้ที่นี่ · ต่างจาก Canvas Q1 ที่วางภาษาและออกจากระบบไว้ในเมนู Workspace
