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

- [ ] `pnpm --filter @friday/web build`, `typecheck`, `test` ผ่าน
- [ ] เปิดทุกเส้นทางในตารางได้ (placeholder) · ยังไม่ล็อกอินถูกพาไป `/login`
- [ ] ล็อกอินกับ API จริงในเครื่องแล้วเห็น Shell + รายชื่อโปรเจกต์ใน Sidebar
- [ ] Storybook ไม่ต้องมี · หน้า `/dev/ui` (เฉพาะ dev) แสดงทุก component ใน UI kit
- [ ] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [ ] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [ ] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [ ] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## ไม่อยู่ในงานนี้

- เนื้อหาของแต่ละหน้า (งาน W01–W21)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
