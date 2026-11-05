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

## มีอะไรแล้ว (รอบแรก)

| กลุ่ม | Endpoint | หน้าจอ |
|---|---|---|
| Auth | `GET auth/csrf` · `POST auth/signup` · `POST auth/login` · `POST auth/logout` | J1, J2 |
| ผู้ใช้ | `GET me` · `GET me/workspaces` | I, Q1 |
| Workspace | `GET workspaces/slug-available` · `POST workspaces` | J5, Q1 |
| โปรเจกต์ | `GET / POST w/{ws}/projects` · `GET …/key-available` · `GET …/{key}` · `GET …/{key}/my-permissions` · `PUT …/{key}/role-permissions` · `POST …/{key}/join-as-admin` | A, L2, M1, N1 |
| งาน | `GET / POST w/{ws}/projects/{key}/issues` · `GET / PATCH w/{ws}/issues/{issueKey}` | 2, B, C, D, K1 |

กติกาที่ทำงานแล้ว (มี test ยืนยันทุกข้อใน `test/api.e2e.test.ts`):
- Session cookie (`HttpOnly`) + CSRF แบบ double submit (`GET auth/csrf` แล้วส่ง header `x-csrf-token`) · ใส่รหัสผิด 5 ครั้งล็อก 15 นาที
- Workspace จาก URL · ไม่ใช่สมาชิกตอบ 404 · ทุก query ผ่าน RLS ด้วย `withTenant`
- สร้างโปรเจกต์พร้อม Workflow มาตรฐาน, Workflow ของ Bug (ผูกคอลัมน์ Kanban), ประเภทงาน 4 แบบ, Module, Milestone และ Sprint 2 สัปดาห์
- Size → Man-Day · Plan Start ตรงวันหยุดเลื่อนเป็นวันทำงานถัดไป · Plan End = Man-Day ÷ จำนวน Dev นับเฉพาะวันทำการ (ข้ามวันหยุด ธปท. และวันหยุดโปรเจกต์)
- Sub-task สืบทอด Module / กลุ่มงาน / Sprint · ซ้อนได้ 2 ชั้น · เตือนเมื่อวันที่เกินช่วงงานแม่
- `ETag` + `If-Match` · version ไม่ตรงตอบ 409 พร้อมค่าล่าสุด
- เลื่อน Due ออกต้องมีสิทธิ์ `issue.change_due_directly` (PM เปิดให้ Member ได้ที่ `role-permissions`) · ดึงเข้าแก้ได้เลย
- หลังตั้ง Baseline การแก้แผนต้องมีเหตุผลและบันทึก `plan_changes` · ทุกการแก้บันทึก `activities`
- เปลี่ยนสถานะแล้วตั้ง Actual Start / End อัตโนมัติ
- Workspace Admin เข้าร่วมโปรเจกต์ Private ได้ (Audit + แจ้ง Project Owner) · Guest ที่เป็น Viewer เห็นเฉพาะงานที่แชร์และไม่เห็นข้อมูลคน

## ยังไม่ทำ

2FA, Google / Microsoft login, ยืนยันอีเมล (ส่งอีเมลปิดไว้ช่วงแรก), เชิญสมาชิก, คำขอเลื่อน Due (K3), คอมเมนต์, Checklist, ไฟล์, Import Excel, Kanban / Timeline / Gantt endpoints, แจ้งเตือนผ่านคิว (BullMQ), OpenAPI
