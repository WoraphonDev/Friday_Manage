# ตรวจปุ่ม การแจ้งเตือน และ Popup — 6 พฤศจิกายน 2569

พบปัญหาเพิ่มเติม **6 จุด** ในกระดิ่ง/Inbox/Realtime โดยแยกจาก Bug Billing และ Automation ในรายงานก่อนหน้า ไม่ได้แก้โค้ดผลิตภัณฑ์ในรอบตรวจ · **แก้ครบทั้ง 6 จุดแล้วในรอบถัดมา** ดู [ผลการแก้](#ผลการแก้)

## รุ่นและขอบเขต

- ใช้สำเนาเว็บ commit `580989a` และ Backend ของสำเนา audit เดิม แยก DB `friday_codex_audit2_20261106` จาก Claude
- ระหว่างตรวจ HEAD เปลี่ยนเป็น `9927192` ซึ่งรวมการแก้รายงานก่อนหน้าแล้ว ตรวจ `git diff 580989a HEAD` ยืนยันว่า **apps/web ทั้งหมด, notifications.service.ts และ realtime.service.ts ที่เกี่ยวกับข้อค้นพบนี้ไม่เปลี่ยน** จึงยังพบปัญหาใน source ปัจจุบัน ส่วน Billing/Automation/0012 ที่ Claude เพิ่งแก้ไม่ได้ตรวจซ้ำในรอบ UI นี้
- ทดสอบด้วย Node 22.23.3 ตาม CI, เว็บ production build บน `localhost:43200`, API บน `43201` และข้อมูลสมมติเท่านั้น
- [หลักฐานและไฟล์ repro](ui-interaction-audit-2026-11-06/) เก็บเป็น `.txt` เพื่อไม่เข้า suite ของ Claude อัตโนมัติ

## รายการให้แก้

| ID | ระดับ | ปัญหา | วิธีที่ยืนยัน | สถานะ |
|---|---|---|---|---|
| UI-01 | P2 | กระดิ่งโหลดรายการล้มเหลวแล้ว Popup ว่าง ไม่มี Error / requestId / ปุ่มลองใหม่ | Component + API 503 จำลอง | แก้แล้ว |
| UI-02 | P3 | กระดิ่งไม่แสดงชื่องานจาก notification จริง | API จริง + Component ด้วยรูปแบบ payload จริง | แก้แล้ว |
| UI-03 | P2 | แจ้งเตือนที่อ่านแล้วของ Workspace อื่นเปิด Inbox ผิดทีม | Component + ตรวจเงื่อนไข summary ใน API | แก้แล้ว |
| UI-04 | P2 | กด “อ่านทั้งหมด” แล้ว API ล้มเหลว ไม่มีข้อความแจ้งผู้ใช้ | Component + 503; พบ Unhandled Rejection | แก้แล้ว |
| UI-05 | P2 | อยู่ใน Inbox แล้วเลือกแจ้งเตือนใหม่ผ่าน `?n=` แต่รายละเอียดค้างรายการเก่า | Component เปลี่ยน search params โดยไม่ remount | แก้แล้ว |
| UI-06 | P2 | อ่านทั้งหมดจากอีก session แล้วจำนวนยังไม่อ่านไม่ซิงก์ไป session ที่เชื่อม Realtime | API + WebSocket ผ่าน proxy จริง | แก้แล้ว |

### UI-01 — โหลดแจ้งเตือนล้มเหลวแล้ว Popup ไม่มีคำอธิบาย

ตำแหน่ง: `apps/web/src/features/bell/Bell.tsx:116`

เปิดกระดิ่งแล้ว `GET /me/notifications?filter=all&limit=8` ตอบ 503 พร้อม `message` และ `requestId` ใน response ผลจริงแผงมีหัวข้อ/แท็บ แต่พื้นที่รายการไม่มี Error หรือวิธีลองใหม่ เพราะ render เฉพาะ `isPending`, ข้อมูลว่าง และรายการ ไม่มีกรณี `list.isError`

เกณฑ์ผ่าน: แสดงข้อความที่เข้าใจได้พร้อม requestId และปุ่มลองใหม่ เมื่อกดลองใหม่แล้ว API กลับมาปกติ ต้องแสดงรายการโดยไม่ต้อง reload ทั้งหน้า

### UI-02 — API ส่ง `issueTitle` แต่กระดิ่งอ่าน `title`

ตำแหน่ง: `apps/web/src/features/bell/Bell.tsx:121` · ต้นทาง `apps/api/src/notifications/fanout.ts:79`

Dev สร้างงานสมมติแล้วมอบหมายให้ Lead ผ่าน API จริง ได้ notification ของ DP-3 ดังนี้:

```json
{
  "eventType": "issue.assigned",
  "payload": {
    "issueKey": "DP-3",
    "issueTitle": "UI audit notification task",
    "actorName": "Kaijeaw"
  }
}
```

กระดิ่งประกอบข้อความจาก `[payload.issueKey, payload.title]` จึงแสดงผู้ทำกับรหัส DP-3 โดยไม่มีชื่องาน Test เดิมใช้ fixture `payload.title` จึงไม่เจอปัญหานี้

เกณฑ์ผ่าน: ใช้รูปแบบ payload จริงใน regression และแสดงชื่องานได้ คง fallback ของ event ชนิดอื่นที่ใช้ `title` ด้วย ตรวจ fallback ใน Inbox เมื่อ `issue` ไม่มี/ถูกลบเพิ่มเติม ไม่ใช้ชื่อจาก fixture ที่ต่างจาก API จริง

### UI-03 — ลิงก์ประวัติแจ้งเตือนพาไป Workspace ปัจจุบันแทนเจ้าของรายการ

ตำแหน่ง: `apps/web/src/features/bell/Bell.tsx:79,123` และ `apps/api/src/notifications/notifications.service.ts:99`

1. ผู้ใช้อยู่ Workspace A และเป็นสมาชิก B ด้วย
2. กระดิ่งรวมทุก Workspace มีรายการของ B ที่อ่านแล้ว
3. B ไม่มีรายการยังไม่อ่าน จึงไม่อยู่ใน `summary.workspaces` — API summary กรอง `read_at IS NULL` ก่อน group
4. กดรายการของ B

ผลจริง: `slugOf()` หา B จาก summary ไม่เจอ จึง fallback เป็น A ลิงก์กลายเป็น `/w/A/inbox?n=<รายการของ B>` เมื่อ Inbox กรอง Workspace A ก็ไม่พบรายละเอียดของรายการ B

Test ยืนยันด้วยกรณี `summary={total:0,workspaces:[]}` ขณะที่รายชื่อ Workspace ของผู้ใช้มี B ลิงก์ที่ได้คือ `/w/sample/inbox?...` แทน `/w/other/inbox?...`

เกณฑ์ผ่าน: หา slug จากแหล่งที่มีครบทุก Workspace ที่ผู้ใช้เข้าถึง เช่นรายการ Workspace หรือ DTO ของ notification; อ่านทั้งหมดแล้วลิงก์ของ B ต้องยังเป็น B ห้ามเดาทีมจาก Workspace ที่กำลังเปิดอยู่

### UI-04 — “อ่านทั้งหมด” ล้มเหลวแบบเงียบ

ตำแหน่ง: `apps/web/src/features/bell/Bell.tsx:82–84,110`

เมื่อ `POST /me/notifications/read-all` ตอบ 503 พร้อมข้อความ `โหลดแจ้งเตือนไม่สำเร็จ` กดปุ่มแล้วไม่เห็น Error/Toast ผลทดสอบพบ **Unhandled Rejection: ApiError** จาก `readAll()` เพราะเรียก `void readAll()` โดยไม่มี catch / mutation onError

เกณฑ์ผ่าน: แสดง Error ที่ใช้ลองใหม่ได้ ไม่รายงานว่าสำเร็จ และไม่มี Unhandled Rejection เพิ่ม pending state กันกดซ้ำระหว่างรอ เมื่อ retry สำเร็จต้อง refresh ตัวนับ กระดิ่ง และ Inbox

### UI-05 — query เปลี่ยนแต่รายการที่เลือกไม่เปลี่ยน

ตำแหน่ง: `apps/web/app/work/[ws]/inbox/_components/inbox-page.tsx:42`

เปิด Inbox ด้วย `?n=first` แล้วเปลี่ยนเป็น `?n=second` ขณะคง component เดิม เช่นคลิกรายการใหม่จากกระดิ่งขณะอยู่ใน Inbox ผลจริงรายละเอียดแสดง First notification task ต่อ ไม่เปลี่ยนเป็น Second notification task

สาเหตุ: `useState(search.get('n'))` อ่าน URL เฉพาะการ mount ครั้งแรก ไม่มีการซิงก์เมื่อค่า query เปลี่ยน Test เดิมตรวจเฉพาะลิงก์เริ่มต้น `?n=` แต่ไม่ตรวจการเปลี่ยนระหว่างใช้งาน

เกณฑ์ผ่าน: query ใหม่เลือก notification ใหม่และทำเครื่องหมายอ่านรายการที่ถูกต้อง ตรวจ Back/Forward, query ถูกลบ, รายการอยู่นอกหน้าที่โหลด และ filter ที่ซ่อนรายการเป้าหมายด้วย โดยไม่บังคับผู้ใช้ reload ทั้งหน้า

### UI-06 — ตัวนับใน session อื่นค้างหลังอ่านทั้งหมด

ตำแหน่ง: `apps/api/src/notifications/notifications.service.ts:131`, `apps/api/src/realtime/realtime.service.ts:294–310` และ `apps/web/src/features/bell/Bell.tsx:73`

Probe ใช้บัญชีสมมติจริง เชื่อม `ws://localhost:43200/api/v1/realtime` ผ่าน Next proxy พร้อม cookie ของ Lead แล้ว subscribe `user:<Lead>`:

1. Dev สร้าง DP-4 มอบหมาย Lead → ได้ signal `type: notification`, `unread.total: 2` ยืนยันว่า proxy และการ push notification ใหม่ทำงาน
2. อีก session ของ Lead เรียกอ่านทั้งหมดสำเร็จ
3. `GET /me/notifications/summary` ตอบ `total:0, workspaces:[]`
4. session WebSocket เดิมไม่ได้รับ signal จำนวนใหม่ภายใน 5 วินาที

หลักฐานอยู่ใน [realtime-probe.json](ui-interaction-audit-2026-11-06/realtime-probe.json) สาเหตุใน source คือ poll ตรวจแถว notification ใหม่ตาม createdAt ไม่ตรวจการเปลี่ยน read/done/snooze ส่วนคำสั่งอ่านไม่ได้ส่ง unread signal และ Bell ปิด summary polling เมื่อ WebSocket connected ดังนั้นตัวนับมีโอกาสค้างต่อจนมีเหตุใหม่หรือ reload ไม่ใช่เพียงการหน่วงหนึ่งรอบ poll

เกณฑ์ผ่าน: read/unread/read-all/done/snooze อัปเดตตัวนับให้ทุก session ของผู้รับ ต้องแยกสัญญาณเปลี่ยนจำนวนจาก “มีแจ้งเตือนใหม่” เพื่อไม่ให้การอ่านกลายเป็น Toast แจ้งเตือนใหม่ 0 รายการ และอย่าส่งข้อมูลข้ามผู้รับ/Workspace

## ผลการแก้

ทุกข้อมี regression test ที่ล้มกับโค้ดเดิมและผ่านกับโค้ดใหม่ (ตรวจโดยถอดโค้ดที่แก้ออกแล้วรัน test ซ้ำ) · test ใช้รูปแบบ payload ที่ API ส่งจริง

| ID | สิ่งที่เปลี่ยน | Regression test |
|---|---|---|
| UI-01 | `Bell.tsx`: `list.isError` แสดง `ErrorState` (ข้อความ + requestId + ปุ่มลองอีกครั้ง) · กดแล้ว refetch เฉพาะรายการ | `inbox-bell.test` › UI-01 |
| UI-02 | ข้อความใช้ `payload.issueTitle ?? payload.title` · Event อื่นที่ใช้ `title` ยังแสดงเหมือนเดิม · Inbox มี fallback เมื่อ `issue` เป็น null อยู่แล้ว | `inbox-bell.test` › UI-02 |
| UI-03 | หา slug จาก `GET /me/workspaces` (cache ร่วมกับ shell) ก่อน summary · ไม่รู้ Workspace เจ้าของ = เปิด Inbox ปัจจุบันแบบไม่เลือกรายการ แทนการเดา | `inbox-bell.test` › UI-03 |
| UI-04 | “อ่านทั้งหมด” เป็น `useMutation`: ล้มเหลวแสดง Toast ข้อความ Error ไม่ refresh · ระหว่างรอปุ่ม disabled · สำเร็จ refresh ตัวนับ กระดิ่ง และ Inbox · ไม่มี Unhandled Rejection | `inbox-bell.test` › UI-04 |
| UI-05 | `inbox-page.tsx`: `?n=` เปลี่ยน → เลือกรายการใหม่ (Back/Forward ใช้ทางเดียวกัน) · query ถูกลบ = ไม่เลือก · ล้างตัวกรองที่อาจซ่อนรายการ · ไม่อยู่ในหน้าที่โหลด = โหลดหน้าถัดไปจนเจอหรือหมด · การอ่านผูกกับรายการที่เลือกจริง | `inbox-bell.test` › UI-05 (2 ข้อ) |
| UI-06 | `NotificationsService` เรียก `RealtimeService.unreadChanged()` หลัง commit ของ read / unread / done / snooze / read-all → ส่ง `{ type: 'unread', unread }` ไป `user:{id}` ของผู้ทำเท่านั้น (ไม่มีคนฟัง = ไม่นับ) · Bell รับ `unread` แล้ว refresh โดยไม่แสดง Toast แจ้งเตือนใหม่ · บันทึกชนิดสัญญาณใน `03-api.md` › Realtime | `realtime.e2e` › UI-06 (2 session ของผู้รับ + ผู้ใช้อื่นไม่ได้รับ) |

ผลหลังแก้: repro [popup-acceptance.test.tsx.txt](ui-interaction-audit-2026-11-06/popup-acceptance.test.tsx.txt) **ผ่าน 14/14** ไม่มี Unhandled Rejection · `@friday/web` ผ่าน 417/417 · `realtime.e2e` 19/19, `api.e2e` + `notification-fanout.e2e` + `events.e2e` 73/73 · typecheck ของ web/api ผ่าน

~~ยังไม่ได้ตรวจ: probe [realtime-probe.mjs.txt](ui-interaction-audit-2026-11-06/realtime-probe.mjs.txt) ผ่าน Next proxy จริง และการกดผ่าน browser จริงหลังแก้ (ใช้ e2e WebSocket จริงกับ API แทน)~~

**ตรวจแล้ว 13 พ.ย. 2569** บน Docker ในเครื่อง (เว็บ :3000 → API :3001 · ฐานข้อมูล `friday_canvas_qa`):

- Probe ผ่าน Next proxy: [realtime-probe-proxy.mjs.txt](ui-interaction-audit-2026-11-06/realtime-probe-proxy.mjs.txt) (ดัดแปลงจากชุดเดิม · HTTP และ WebSocket ไปที่ `localhost:3000` ทั้งหมด · 2 session ของผู้ใช้คนเดียวกัน) → [realtime-probe-proxy.json](ui-interaction-audit-2026-11-06/realtime-probe-proxy.json): สัญญาณ `notification` ถึงทั้ง 2 session · อ่านทั้งหมดใน session A แล้ว session B ได้ `{ type: "unread", unread.total: 0 }` (UI-06) · summary เป็น 0
- กดใน Chromium จริง (2 context login แยกกัน): บอทมอบหมายงาน 2 งาน → กระดิ่งทั้งสอง session เป็น "2 รายการยังไม่อ่าน" ทันที และมี Toast ของงานนั้น · รายการในกระดิ่งแสดงชื่องาน (UI-02) · รายการของ Workspace อื่นลิงก์ไป `/work/{Workspace นั้น}/inbox?n=…` (UI-03) · "อ่านทั้งหมด" ใน A → กระดิ่งของ B เป็น 0 โดยไม่โหลดหน้าใหม่ (UI-06) · ใน Inbox กดรายการจากกระดิ่ง / Back / Forward แล้วรายการที่เลือกเปลี่ยนตาม `?n=` ทุกครั้ง (UI-05)
- UI-01 / UI-04 (โหลดแจ้งเตือนหรืออ่านทั้งหมดล้มเหลว) ต้องทำให้ API ล้มจึงไม่ได้กดในเบราว์เซอร์ · ยังยืนยันด้วย regression test ของรอบแก้

## ผลทดสอบที่ผ่าน (รอบตรวจ ก่อนแก้)

| กลุ่ม | ผล |
|---|---|
| ชุด interaction เดิม 16 ไฟล์ | **223 ผ่านทั้งหมด** |
| กรณีปุ่ม/Toast/Dialog ที่เพิ่ม | **9 ผ่าน** |
| Acceptance ใหม่ UI-01–05 | **5 ไม่ผ่านตามเกณฑ์ที่ถูกต้อง** พร้อม 1 Unhandled Rejection ของ UI-04 |
| Notification ใหม่ผ่าน WebSocket proxy จริง | ผ่าน — subscribe และ signal จำนวน 2 มาถึง |
| อ่านทั้งหมดผ่าน API จริง | ผ่าน — summary กลายเป็น 0 แต่ไม่ push ไป session อื่นตาม UI-06 |

16 ไฟล์ที่รันครอบคลุม UI kit, Issue Drawer, Shell, Inbox/Bell, Command palette/Search, Files, Profile, Admin/Automation, Project settings, Gantt, Backlog, Calendar, Kanban, Overview/Table, Home/My Tasks และ Lead dashboard/Reports เป็น component tests กับ MSW ไม่ใช่การกดทุกปุ่มด้วย browser จริง

9 กรณีใหม่ที่ผ่าน:

| สิ่งที่ตรวจ | ผล |
|---|---|
| กระดิ่งเปลี่ยนแท็บ, Escape ปิด และคืนโฟกัส | ผ่าน |
| กระดิ่ง “อ่านทั้งหมด” กรณี API สำเร็จ | ผ่าน |
| Confirm กดยกเลิกแล้วไม่เรียก mutation | ผ่าน |
| ระหว่างยืนยัน: ปุ่ม disabled, Escape ไม่ปิด, ส่งคำขอครั้งเดียว | ผ่าน |
| ยืนยันล้มเหลว: Dialog คงอยู่ มี Error และไม่มี success toast | ผ่าน |
| Toast เลิกทำสำเร็จ: เรียกครั้งเดียวและปิด | ผ่าน |
| Toast เลิกทำล้มเหลว: แสดง Error | ผ่าน |
| Toast ปิดด้วยปุ่มและปิดตามเวลา | ผ่าน |
| Dialog กัก Tab ภายใน, Escape ปิดและคืนโฟกัส | ผ่าน |

## สิ่งที่ตรวจผ่าน browser จริง

- เปิด Table, เมนู Workspace, เปลี่ยน English → ไทย และเมนูปิดหลังเลือก
- กด + New เปิดฟอร์มสร้างงาน; ส่งข้อมูลว่างแล้ว validation ห้ามส่งและโฟกัส Module
- เลือก Module, กรอกชื่อและกดสร้าง ได้ **DP-2: UI Audit button task** และเปิดรายละเอียดงานจริง
- เปิดแท็บ Checklist ของ DP-2 ได้; **ไม่ได้ยืนยันการเพิ่ม Checklist ผ่าน browser** เพราะการควบคุม Chrome ถูกคั่นด้วยการใช้งานแท็บ Canvas พร้อมกัน

การตรวจ browser รอบนี้ไม่ครอบคลุมทุกปุ่ม/ทุกหน้า/ทุกความกว้าง ไม่ใช้ผล component test แทน visual acceptance และไม่ถือว่าระบบทุกส่วนปกติ เพราะยังมี 6 ข้อข้างต้น ไม่มีการแก้โค้ดหรือหยุด server ของ Claude

## ใช้ repro ต่อ

คัดลอก [popup-acceptance.test.tsx.txt](ui-interaction-audit-2026-11-06/popup-acceptance.test.tsx.txt) ไป `apps/web/src/lib/ui-popup-audit.test.tsx` ใน checkout ทดสอบ แล้วรันด้วย Node 22:

```sh
pnpm --filter @friday/web exec vitest run src/lib/ui-popup-audit.test.tsx
```

ปัจจุบัน 9 ผ่าน / 5 ล้ม; หลังแก้ UI-01–05 ต้องผ่าน **14 ข้อ** และไม่มี Unhandled Rejection ส่วน UI-06 ใช้ [realtime-probe.mjs.txt](ui-interaction-audit-2026-11-06/realtime-probe.mjs.txt) กับ API/เว็บ/DB ทดสอบแยกเท่านั้น Probe มีการสร้างงานสมมติและอ่านแจ้งเตือนทั้งหมดของบัญชีทดสอบ ห้ามรันกับบัญชีหรือฐานข้อมูลใช้งานจริง
