# A28 · API token (Bearer)

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | T00, A13 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/auth/**` · `apps/api/test/api-tokens.e2e.test.ts` |
| หน้าจอ | N1 (`design/canvas/AdminConsole.dc.html`) |
| สเปก | 03-api › 1 การยืนยันตัวตน · 03-api › 3.3 แถว `w/api-tokens` · 04-permissions › 5 ข้อ 9 |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `CRUD w/api-tokens` (แสดง token เต็มครั้งเดียว, เก็บ hash, scopes)
- `Authorization: Bearer` ใน `auth.guard.ts`: สิทธิ์ = สิทธิ์ของผู้สร้าง ∩ scopes · ไม่ต้องใช้ CSRF

## กติกาที่ต้องตรง

- ทำหลัง A13 merge (lane เดียวกัน)

## เสร็จเมื่อ

- [x] test: token อ่านได้แต่เขียนไม่ได้ตาม scope, token ที่ยกเลิกแล้วได้ 401
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

### Endpoint ที่เพิ่ม (`apps/api/src/auth/`)

| Method | Path | สิทธิ์ | หมายเหตุ |
|---|---|---|---|
| GET | `w/:ws/api-tokens` | Owner / Admin (`ws.settings`) | token ที่ยังไม่ถูกยกเลิก · ไม่มีตัว token (เก็บเฉพาะ hash) · `lastUsedAt` |
| POST | `w/:ws/api-tokens` `{ name, scopes? }` | Owner / Admin | คืน `token` เต็ม (`fmt_` + 43 ตัว) **ครั้งเดียว** · scopes ค่าเริ่มต้น `["read"]` · ใช้งานพร้อมกันได้ ≤ 20 ตัว (422 `api_token_limit`) · Audit `api_token.created` |
| PATCH | `w/:ws/api-tokens/:id` `{ name?, scopes? }` | Owner / Admin | Audit `api_token.updated` |
| DELETE | `w/:ws/api-tokens/:id` | Owner / Admin | ยกเลิกทันที · Audit `api_token.revoked` |

### การยืนยันตัวตนด้วย `Authorization: Bearer fmt_…` (ใน `AuthGuard`)

- ใช้ Bearer **แทน**คุกกี้ (ถ้ามีทั้งคู่ยึด Bearer) · ไม่ต้องส่ง CSRF · คำขอที่ token ไม่ถูกต้อง / ถูกยกเลิก / ผู้สร้างไม่ได้เป็นสมาชิก active แล้ว / Workspace ถูกลบ → 401 `invalid_token` (route `@Public()` ไม่ล้มเพราะ token เสีย)
- **สิทธิ์ = สิทธิ์ของผู้สร้าง ∩ scopes** (04-permissions ข้อ 9): คำขอรันเป็นผู้สร้าง token จึงผ่านการตรวจสิทธิ์ RBAC ทุกชั้นตามปกติ (ผู้สร้างถูกลด Role หรือปิดใช้งานแล้ว token ตามไปทันที) แล้ว scope ตัดซ้ำ:
  - `read` = GET / HEAD เท่านั้น · `write` = ทุก method (รวม read) · เกิน scope → 403 `insufficient_scope` (`details.required`, `details.scopes`)
- **ขอบเขต**: token ใช้ได้เฉพาะ `/api/v1/w/{Workspace ที่สร้าง}/…` (Workspace อื่น → 403 `token_workspace_mismatch`) และ `GET /api/v1/me` เท่านั้นนอก Workspace
- **ส่วนที่ token เข้าไม่ได้เลย แม้ `write`** (403 `token_not_allowed`): `api-tokens`, `channels`, `billing`, `members`, `invitations`, `invite-links`, `access-requests`, `notification-templates`, `saved-searches`, `leaves`, `me/*` และ API ระดับบัญชีทั้งหมด (`/me/*`, `/workspaces`, …) — กัน token ที่หลุดยกระดับตัวเอง สร้าง token ใหม่ เปลี่ยนช่องทางแจ้งเตือน หรือแก้สมาชิก / แพ็กเกจ
- `last_used_at` อัปเดตไม่เกินนาทีละครั้ง

### คำตัดสินที่เลือกเอง

- scopes มี 2 ค่า `read` / `write` เท่านั้น: สเปกบอกแค่ "ตาม scopes ของ token" ไม่ระบุรายการ · แบ่งตามทรัพยากร (issues / files ฯลฯ) เพิ่มทีหลังได้โดยไม่กระทบ token เดิม (`write` ยังหมายถึงทั้งหมด)
- ไม่มีวันหมดอายุ: ตาราง `api_tokens` ไม่มีคอลัมน์ `expires_at` ตาม T00 · ยกเลิกด้วย `DELETE` เท่านั้น
- ไม่มีตัวบอก "4 ตัวท้าย" ของ token ในรายการ เพราะเก็บเฉพาะ hash (ผู้ใช้แยกด้วยชื่อ)
- Audit ของการเขียนผ่าน token ยังบันทึกเป็นผู้สร้าง token (ผ่านโค้ดเดิม) ไม่มีเครื่องหมายว่ามาจาก token — มี `sessionId = token:<id>` ใน `AuthInfo` ให้ใช้ต่อได้

### คำขอนอก lane

- **T00** (ถ้าต้องการ): เพิ่ม `api_tokens.expires_at` และ `last_ip`
- **A40 (OpenAPI)**: ประกาศ security scheme `bearerAuth` และระบุ scope ของแต่ละ route (GET = read, อื่น = write)
- **W18**: หน้า Admin Console › API tokens เรียก endpoint ข้างบน แสดง token เต็มครั้งเดียวพร้อมปุ่มคัดลอก

### ผล test

`apps/api/test/api-tokens.e2e.test.ts` 7 ข้อ: สร้าง (ครั้งเดียว/hash/scope เริ่มต้น/Audit) · ตรวจข้อมูล · เฉพาะ Admin · จำกัด 20 ตัว · แก้ / ยกเลิก (ใช้ไม่ได้ทันที) · **read อ่านได้เขียนไม่ได้, write เขียนได้โดยไม่ต้องมี CSRF และเป็นผู้สร้าง** · **ผู้สร้างถูกลด Role / ปิดใช้งาน token ตามทันที** · Workspace อื่น · ส่วนอ่อนไหว · Bearer เสีย / ไม่ผสมคุกกี้ / route สาธารณะ · API ทั้งชุด 423 ผ่าน · `pnpm typecheck` ผ่าน
