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
| สมาชิก | `GET w/{ws}/members` · `GET / POST w/{ws}/invitations` · `POST …/invitations/{id}/revoke` · `GET invitations/{token}` · `POST invitations/{token}/accept` · `…/decline` | H, 7, J4 |
| Import Excel | `POST w/{ws}/import-jobs` (multipart) · `GET / PATCH w/{ws}/import-jobs/{id}` · `POST …/{id}/commit` | L3 |

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
- Import Excel ตามหน้า L3: จับคู่คอลัมน์อัตโนมัติ 17 ช่อง · **เลขงาน = คอลัมน์ ID** (DP-39 ตรงกับ Prototype) · No. ใช้จับคู่ตอนอัปเดต · จับคู่ชื่อคนกับสมาชิก / เชิญด้วยอีเมล / ไม่ระบุ · ตรวจตามหน้า L3 (ไม่มี BA = ข้าม, ไม่มีวันที่ = Backlog, Plan Start ตรงวันหยุด, คอลัมน์ Sprint ผิดช่อง, Status ว่าง, คนที่ไม่พบ) · สร้างโปรเจกต์, Module, กลุ่มงาน, FR / Screen, งาน, Baseline v1 และวันหยุดจากชีต Holidays ในธุรกรรมเดียว

### ทดสอบกับไฟล์แผนจริง (เฉพาะในเครื่อง)

```bash
REAL_PLAN_FILE="$HOME/Downloads/Development Plan 2026-11 (2026-11-05).xlsx" pnpm --filter @friday/api exec vitest run real-plan
```

ผลล่าสุด (5 พ.ย. 2569): 334 แถว · 11 Module · 62 กลุ่มงาน · 944 MD · นำเข้า 333 งาน (ลงแผน 310 · Backlog 23 · ข้าม 1) ใช้เวลาไม่ถึง 0.5 วินาที · Plan Start ตรงวันหยุด 11 งานและคอลัมน์ Sprint ผิด 9 แถว ตรงกับ docs/review-round-2.md

## ยังไม่ทำ

2FA, Google / Microsoft login, ยืนยันอีเมล (ส่งอีเมลปิดไว้ช่วงแรก), ลิงก์เชิญแบบแชร์, Import โหมดอัปเดตแผนเดิม, คำขอเลื่อน Due (K3), คอมเมนต์, Checklist, ไฟล์, Kanban / Timeline / Gantt endpoints, แจ้งเตือนผ่านคิว (BullMQ), OpenAPI
