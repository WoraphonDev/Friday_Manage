# A14 · สมาชิก Workspace, ลิงก์เชิญ และคำขอเข้าร่วม

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | — เริ่มได้เลย |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/workspaces/**` · `apps/api/test/members.e2e.test.ts` · `apps/api/src/invitations/**` |
| หน้าจอ | H (`design/canvas/WorkspaceMembers.dc.html`) · 7 (`design/canvas/Members.dc.html`) · J4 (`design/canvas/AcceptInvite.dc.html`) · M1 (`design/canvas/States.dc.html`) |
| สเปก | 03-api › 3.2 · 04-permissions › 1, 2 |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `GET / PATCH w/` · `PATCH w/members/{userId}` (Role: Owner คนสุดท้ายลดไม่ได้, Admin ตั้ง Owner ไม่ได้, Guest → Member ตรวจ Seat ผ่าน `PlanLimits`) · Audit `perm.role_changed`
- `POST w/members/{userId}/deactivate` · `/reactivate` · ปิดแล้วยกเลิก Session ทั้งหมด (`SessionService`) และคืนรายการงานค้างให้หน้า P3 โอนงาน
- `POST w/invitations/{id}/resend` · `POST / DELETE w/invite-links` · `POST join/{linkToken}`
- `GET / POST w/access-requests` · `POST p/access-requests` (M1 403) · `POST …/{id}/approve` · `/reject`
- Event `member.invited`, `member.joined` (เพิ่มการส่ง Event ในการเชิญที่มีอยู่)

## กติกาที่ต้องตรง

- Guest ไม่นับ Seat · ข้อจำกัดอื่นตาม 04-permissions

## เสร็จเมื่อ

- [x] test ครอบคลุมทุกข้อ
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- Admin Console (A18)
- Teams (A18)

## บันทึกผล

### Endpoint ที่เพิ่ม (`apps/api/src/workspaces/`, `invitations/`)

| Method | Path | สิทธิ์ | หมายเหตุ |
|---|---|---|---|
| GET | `w/:ws` | สมาชิกทุกคน รวม Guest | ข้อมูล Workspace + `role` ของฉัน |
| PATCH | `w/:ws` | Owner / Admin (`ws.settings`) | `name`, `logoUrl`, `defaultLocale`, `allowDomainJoin` · Audit `workspace.updated` |
| PATCH | `w/:ws/members/:userId` | `ws.members.manage` | `role`, `jobTitle`, `department` · Audit `perm.role_changed` |
| GET | `w/:ws/members/:userId/handover` | `ws.members.manage` | งานค้าง (ที่ยังไม่เสร็จ) + โปรเจกต์ที่เป็น Project Owner สำหรับหน้า P3 |
| POST | `w/:ws/members/:userId/deactivate` · `reactivate` (และ `:deactivate` / `:reactivate`) | `ws.members.manage` | ปิดคืน `{ status, signedOut, handover }` · เปิดตรวจ Seat |
| POST | `w/:ws/invitations/:id/resend` (และ `:resend`) | ผู้ส่ง หรือ `ws.members.manage` | ออก token ใหม่ ของเดิมใช้ไม่ได้ · ต่ออายุ (อย่างน้อย 7 วัน) |
| GET / POST / DELETE | `w/:ws/invite-links` · `/:id` | `ws.members.manage` | token แสดงครั้งเดียวตอนสร้าง (`url`) · เก็บ SHA-256 · Role ได้เฉพาะ `member` / `guest` · อายุ 1 / 7 / 30 วัน |
| GET | `join/:token` | สาธารณะ | ข้อมูลลิงก์: Workspace, Role, `status` (valid / expired / revoked) |
| POST | `join/:token` | ล็อกอิน | เข้าร่วมเป็นสมาชิก · เป็นสมาชิกอยู่แล้ว `alreadyMember: true` |
| POST | `w/:ws/access-requests` | ล็อกอิน (ไม่ต้องเป็นสมาชิก) | ขอเข้า Workspace · ต้อง `allowDomainJoin` และอีเมลอยู่ในโดเมนที่ยืนยัน DNS แล้ว |
| POST | `w/:ws/projects/:key/access-requests` | สมาชิก Workspace (ไม่ใช่ Guest) | ขอเข้าโปรเจกต์ (หน้า 403 / M1) |
| GET | `w/:ws/access-requests?status=pending\|approved\|rejected\|cancelled\|all` | Owner / Admin เห็นทั้งหมด · Project Owner / Admin เห็นเฉพาะโปรเจกต์ตัวเอง | |
| POST | `w/:ws/access-requests/:id/approve` `{ role? }` · `reject` (และ `:approve` / `:reject`) | ผู้มีสิทธิ์ข้างบน | อนุมัติเข้า Workspace = Member (ตรวจ Seat) · เข้าโปรเจกต์ = `role` (ค่าเริ่มต้น member, Guest ได้ Viewer เท่านั้น) |

### กติกา

- **Role** (04-permissions ข้อ 2): Owner คนสุดท้ายลดไม่ได้ (409 `last_owner`) · Admin ตั้ง Owner หรือแก้ Role ของ Owner ไม่ได้ (403 `ws.owner`) · Guest → Member / Admin / Owner ตรวจ Seat (402) · Guest ไม่นับ Seat
- **ปิดการใช้งาน**: ปิดตัวเองไม่ได้ · Admin ปิด Owner ไม่ได้ · Owner คนสุดท้ายปิดไม่ได้ · ปิดแล้ว `TenantGuard` ตัดทางเข้า Workspace นี้ทันที
- **คำเชิญ**: ตรวจ Seat ตั้งแต่ตอนสร้าง (สมาชิกที่ active + คำเชิญใหม่ที่ไม่ใช่ Guest ต้องไม่เกินแพ็กเกจ) → 402 `plan_limit_reached` เดิมตรวจแค่ตอนตอบรับ
- **Event** (EventBus, หลัง commit): `member.invited` (ต่อคำเชิญ, มี `projectId` เมื่อเชิญเข้าโปรเจกต์ → PM ได้ Inbox ผ่าน fan-out ของ A23) · `member.joined` เมื่อตอบรับคำเชิญ / เข้าด้วยลิงก์ / อนุมัติคำขอ (`data.via` = invitation · invite_link · access_request)
- แจ้งผู้เกี่ยวข้องด้วย `Notifier`: `access_request.created` (ถึง Admin; คำขอโปรเจกต์ถึง Project Owner + Admin ของโปรเจกต์ + Admin Workspace) และ `access_request.decided` (ถึงผู้ขอ)

### คำตัดสินที่เลือกเอง

- **ปิดการใช้งานแล้วยกเลิก Session และ LINE binding เฉพาะเมื่อคนนั้นไม่เหลือ Workspace อื่นที่ยัง active** เพราะทั้งสองอย่างเป็นของ "บัญชี" ไม่ใช่ของ Workspace (สเปกเขียนยกเลิกทั้งหมดโดยไม่คิดกรณีหลาย Workspace) · ผลคือ `signedOut: false` เมื่อยังอยู่ที่อื่น
- **ลิงก์เชิญ**: ใช้ token ขึ้นต้น `lnk_` เพื่อให้หน้าเว็บ `/join/[token]` แยกออกจาก token คำเชิญรายอีเมล (`GET invitations/{token}`) · W01: ถ้า token ขึ้นต้น `lnk_` ให้เรียก `GET/POST join/{token}` แทน
- **`POST w/:ws/access-requests` ไม่ใช้ `TenantGuard`** เพราะผู้ขอยังไม่ได้เป็นสมาชิก (ตอบ 404 ถ้า slug ไม่มี) · ขอเข้าโปรเจกต์ค้นโปรเจกต์ด้วย SYSTEM_DB เพราะโปรเจกต์ Private ถูก RLS ซ่อนจากคนที่ยังไม่ใช่สมาชิก
- การแจ้งผู้เชิญตอนตอบรับ: เดิมแจ้งผู้เชิญเสมอ ตอนนี้ PM ได้ผ่าน Event และแจ้งผู้เชิญแยกเฉพาะเมื่อผู้เชิญไม่ใช่ PM (กันได้ซ้ำ 2 รายการ)
- ไม่ทำ `GET/PATCH w/me/membership` (ไม่อยู่ในรายการ "ทำอะไร" ของ A14 · เป็นของ Profile / A20) และ Teams (A18)

### คำขอนอก lane

- **A29 test**: `plans.e2e.test.ts` เคส "เกินจำนวนที่นั่งตอนตอบรับคำเชิญ" ปรับให้รับ 402 ตั้งแต่สร้างคำเชิญ (พฤติกรรมใหม่ของ A14) แล้ว
- **W10 / W01**: ใช้ endpoint ข้างบน · Guest เห็นเฉพาะ `GET w/:ws`
- **A18**: `PATCH w/` รับเฉพาะ 4 ฟิลด์ที่ A14 ดูแล (ชื่อ, โลโก้, ภาษา, เข้าร่วมด้วยโดเมน) · ค่าอื่นของ `workspace_settings` เป็นของ Admin Console

### ผล test

`apps/api/test/members.e2e.test.ts` 20 ข้อ: Workspace get/patch · Role (สิทธิ์ Owner/Admin, Owner คนสุดท้าย, Guest→Member ติด Seat 402, Audit) · ปิด/เปิดใช้งาน (handover, Session + LINE, หลาย Workspace, ข้อจำกัด, Seat) · คำเชิญ (Seat ล่วงหน้า, ส่งซ้ำ, Event, แจ้ง PM ครั้งเดียว) · ลิงก์เชิญ (สร้าง/เพิกถอน/เข้าร่วม/หมดอายุ/ปิดใช้งาน/Seat/Guest) · ขอเข้า Workspace ด้วยโดเมน (เปิด/ปิด, ยืนยัน DNS, อนุมัติ/ปฏิเสธ, Seat) · ขอเข้าโปรเจกต์ (Owner / Admin โปรเจกต์ตัดสิน, ขอบเขตการมองเห็น, Guest) · API ทั้งชุด 367 ผ่าน · `pnpm typecheck` ผ่าน
