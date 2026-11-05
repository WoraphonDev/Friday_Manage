# @friday/api

API ของ Friday Manage (NestJS 11 · Express 5) ตามสเปก [docs/spec/03-api.md](../../docs/spec/03-api.md) · ทุก route ขึ้นต้นด้วย `/api/v1`

## เริ่มใช้งานในเครื่อง

```bash
pnpm install
pnpm db:up && pnpm db:migrate && pnpm db:dev-roles   # ฐานข้อมูล + บัญชี friday_api / friday_worker
pnpm api:dev                                         # build ด้วย SWC แล้วรันที่ http://localhost:3001/api/v1
pnpm test                                            # test ของ packages/db แล้วต่อด้วย apps/api (ใช้ฐานข้อมูลจริง)
```

Nest ใช้ decorator metadata ซึ่ง esbuild / tsx ไม่สร้างให้ จึง build ด้วย SWC (`.swcrc`) และ test ด้วย `unplugin-swc` · typecheck ใช้ TypeScript 5.9 (`pnpm typecheck`)

## มีอะไรแล้ว

| กลุ่ม | Endpoint | หน้าจอ |
|---|---|---|
| Auth | `GET auth/csrf` · `POST auth/signup` · `POST auth/login` · `POST auth/logout` | J1, J2 |
| ผู้ใช้ | `GET me` · `GET me/workspaces` | I, Q1 |
| Workspace | `GET workspaces/slug-available` · `POST workspaces` | J5, Q1 |
| โปรเจกต์ | `GET / POST w/{ws}/projects` · `GET …/key-available` · `GET …/{key}` · `GET …/{key}/my-permissions` · `PUT …/{key}/role-permissions` · `POST …/{key}/join-as-admin` | A, L2, M1, N1 |
| งาน | `GET / POST w/{ws}/projects/{key}/issues` · `GET / PATCH w/{ws}/issues/{issueKey}` | 2, B, C, D, K1 |
| สมาชิก | `GET w/{ws}/members` · `GET / POST w/{ws}/invitations` · `POST …/invitations/{id}/revoke` · `GET invitations/{token}` · `POST invitations/{token}/accept` · `…/decline` | H, 7, J4 |
| Import Excel | `POST w/{ws}/import-jobs` (multipart) · `GET / PATCH w/{ws}/import-jobs/{id}` · `POST …/{id}/commit` | L3 |
| คำขอเลื่อน Due | `GET w/{ws}/issues/{key}/due-requests/preview?due=` · `GET / POST w/{ws}/issues/{key}/due-requests` · `GET w/{ws}/due-requests?scope=to_approve\|mine` · `POST w/{ws}/due-requests/{id}/approve` · `/reject` · `/cancel` | K3, G, E |
| Inbox | `GET me/notifications?workspace=&filter=` · `GET me/notifications/summary` · `POST me/notifications/{id}/read` · `/unread` · `/done` · `/undone` · `/snooze` · `POST me/notifications/read-all` | G, K4 |
| Kanban | `GET w/{ws}/projects/{key}/board?type=bug&level=&assignee=me&overdue=&moduleId=&sprintId=&showOlderDone=` · `POST w/{ws}/issues/{key}/move` | 3, L1, M7 |
| Timeline | `GET w/{ws}/projects/{key}/timeline?from&to` | 4 |

กติกาที่ทำงานแล้ว (มี test ยืนยันทุกข้อใน `test/api.e2e.test.ts`):
- Session cookie (`HttpOnly`) + CSRF แบบ double submit (`GET auth/csrf` แล้วส่ง header `x-csrf-token`) · ใส่รหัสผิด 5 ครั้งล็อก 15 นาที
- Workspace จาก URL · ไม่ใช่สมาชิกตอบ 404 · ทุก query ผ่าน RLS ด้วย `withTenant`
- สร้างโปรเจกต์พร้อม Workflow มาตรฐาน, Workflow ของ Bug (ผูกคอลัมน์ Kanban), ประเภทงาน 4 แบบ, Module, Milestone และ Sprint 2 สัปดาห์
- Size → Man-Day · Plan Start ตรงวันหยุดเลื่อนเป็นวันทำงานถัดไป · Plan End = Plan Start + Man-Day เป็นวันทำการ ตามสูตร WORKDAY ในไฟล์แผน (ข้ามวันหยุด ธปท. และวันหยุดโปรเจกต์ · จำนวน Dev ไม่มีผล)
- Sub-task สืบทอด Module / กลุ่มงาน / Sprint · ซ้อนได้ 2 ชั้น · เตือนเมื่อวันที่เกินช่วงงานแม่
- `ETag` + `If-Match` · version ไม่ตรงตอบ 409 พร้อมค่าล่าสุด
- เลื่อน Due ออกต้องมีสิทธิ์ `issue.change_due_directly` (PM เปิดให้ Member ได้ที่ `role-permissions`) · ดึงเข้าแก้ได้เลย
- หลังตั้ง Baseline การแก้แผนต้องมีเหตุผลและบันทึก `plan_changes` · ทุกการแก้บันทึก `activities`
- เปลี่ยนสถานะแล้วตั้ง Actual Start / End อัตโนมัติ
- Workspace Admin เข้าร่วมโปรเจกต์ Private ได้ (Audit + แจ้ง Project Owner) · Guest ที่เป็น Viewer เห็นเฉพาะงานที่แชร์และไม่เห็นข้อมูลคน
- เชิญหลายอีเมลเข้า Workspace + โปรเจกต์ · ตอบรับได้เฉพาะบัญชีที่ถูกเชิญ · ยกเลิกแล้วลิงก์ตอบ 410 · ส่งอีเมลปิดไว้ช่วงแรก API จึงคืน `inviteUrl` ให้ผู้เชิญส่งต่อ
- **คำขอเลื่อน Due (K3):** ส่งได้เมื่อมี `issue.edit` แต่ไม่มี `issue.change_due_directly` · ต้องเป็นการเลื่อนออก (ดึงเข้าแก้ได้เลย) · รออนุมัติได้ทีละ 1 คำขอต่องาน · `preview` คำนวณวันทำการที่เพิ่ม, Workload ของ Dev ในช่วงที่เลื่อนออก (งานอื่นในโปรเจกต์ที่ช่วงวันซ้อน × ส่วนแบ่ง Man-Day เทียบ capacity), งานที่รออยู่ (Dependency), Milestone / Go-live และรายชื่อผู้อนุมัติ · ผลนี้เก็บไว้ในคำขอ · `PATCH` ที่ถูกปฏิเสธด้วย `due_change_requires_approval` บอกรายชื่อผู้อนุมัติมาด้วย
- อนุมัติ: ต้องมี `due_request.approve` · อนุมัติคำขอของตัวเองไม่ได้ แม้ได้รับสิทธิ์ · แก้ Plan End + Activity + `plan_changes` (source `due_request`, ใช้เหตุผลในคำขอ) · ถ้า Due ถูกแก้ไปแล้วหลังส่งคำขอตอบ `409 due_changed_since_request` · ปฏิเสธใส่เหตุผลได้ · ผู้ขอยกเลิกเองได้
- **Inbox (G):** ผู้อนุมัติได้รับ `due_request.created` · ผู้ขอได้รับ `due_request.decided` · ผู้ทำ action เองไม่ได้รับแจ้ง · ตัวกรอง 6 แบบตามหน้า G พร้อมจำนวน · เมื่อส่ง `workspace` จะเติมสถานะล่าสุดของงานและคำขอ (`canDecide` ใช้แสดงปุ่มอนุมัติ / ปฏิเสธ) · "เตือนฉันพรุ่งนี้" = 09:00 วันถัดไป · แจ้งเตือนเขียนผ่าน friday_system หลังธุรกรรมหลัก (ยังไม่มีคิว ถ้าเขียนพลาดจะ log ไว้ ไม่ทำให้คำขอล้ม)
- **Kanban (3):** คอลัมน์ = สถานะของ Workflow มาตรฐาน · การ์ด Bug วางตาม `board_column_id` และแสดงชื่อสถานะจริง (`?type=bug` ได้บอร์ดของ Workflow Bug) · การ์ดที่เสร็จเกิน 7 วันซ่อนไว้และบอกจำนวน (`hiddenDone`) · WIP นับทุกการ์ดในคอลัมน์ก่อนกรอง
- **ย้ายการ์ด (`move`):** ลาก Bug ลงคอลัมน์ของบอร์ดมาตรฐาน ระบบเลือกสถานะ Bug ที่ผูกกับคอลัมน์นั้น (Review → Fixed) · ไป Done ทั้งที่ Sub-task ยังไม่ครบตอบ `422 subtasks_incomplete` จนกว่าจะส่ง `confirm: true` · เกิน WIP เตือน · ลำดับใช้ `afterKey` (การ์ดเหนือจุดวาง) / `beforeKey` (การ์ดใต้จุดวาง) แบบ fractional index · แก้ลำดับไม่เพิ่ม version (migration 0004) · งานจาก Import ที่ลำดับซ้ำกัน ลากครั้งแรกจัดลำดับใหม่ทั้งโปรเจกต์ · `If-Match` ไม่บังคับ
- **Timeline (4):** Module › กลุ่มงาน › Task › Sub-task พร้อมช่วงวัน, ความคืบหน้ารวม (ถ่วง Man-Day ตาม `progress_method`), วันที่เลยกำหนด · Sprint, Milestone และงานที่ยังไม่มีวันที่ · `from` / `to` กรองแถว แต่ค่ารวมของ Module / กลุ่มงานคิดจากทั้งหมด · Guest ที่เป็น Viewer เห็นทั้งแผนแต่ไม่มีชื่อคน ไม่มี Bug และบอก `canOpen` ว่างานไหนแชร์ให้เปิดได้ · Guest เปิด Kanban ไม่ได้
- Import Excel ตามหน้า L3: จับคู่คอลัมน์อัตโนมัติ 17 ช่อง · **เลขงาน = คอลัมน์ ID** (DP-39 ตรงกับ Prototype) · No. ใช้จับคู่ตอนอัปเดต · จับคู่ชื่อคนกับสมาชิก / เชิญด้วยอีเมล / ไม่ระบุ · ตรวจตามหน้า L3 (ไม่มี BA = ข้าม, ไม่มีวันที่ = Backlog, Plan Start ตรงวันหยุด, คอลัมน์ Sprint ผิดช่อง, Status ว่าง, คนที่ไม่พบ) · สร้างโปรเจกต์, Module, กลุ่มงาน, FR / Screen, งาน, Baseline v1 และวันหยุดจากชีต Holidays ในธุรกรรมเดียว

### ทดสอบกับไฟล์แผนจริง (เฉพาะในเครื่อง)

```bash
REAL_PLAN_FILE="$HOME/Downloads/Development Plan 2026-11 (2026-11-05).xlsx" pnpm --filter @friday/api exec vitest run real-plan
```

ผลล่าสุด (5 พ.ย. 2569): 334 แถว · 11 Module · 62 กลุ่มงาน · 944 MD · นำเข้า 333 งาน (ลงแผน 310 · Backlog 23 · ข้าม 1) ใช้เวลาไม่ถึง 0.5 วินาที · Plan Start ตรงวันหยุด 11 งานและคอลัมน์ Sprint ผิด 9 แถว ตรงกับ docs/review-round-2.md · Kanban 333 การ์ด ~25 ms · Timeline (11 Module, 60 กลุ่มงานที่มีงานลงแผน) ~20 ms · ลากการ์ดครั้งแรก (จัดลำดับใหม่ทั้งโปรเจกต์) ~50 ms

## ยังไม่ทำ

2FA, Google / Microsoft login, ยืนยันอีเมล (ส่งอีเมลปิดไว้ช่วงแรก), ลิงก์เชิญแบบแชร์, Import โหมดอัปเดตแผนเดิม, คอมเมนต์, Checklist, ไฟล์, Gantt / Calendar / Backlog endpoints, แจ้งเตือนผ่านคิว (BullMQ) และช่องทาง LINE / Email / Webhook, อนุมัติจากปุ่มใน LINE, แจ้งเตือนเหตุการณ์อื่น (มอบหมาย, สถานะเปลี่ยน, ใกล้ครบกำหนด), ตั้งค่าการแจ้งเตือน (`notification-prefs`), Realtime, OpenAPI
