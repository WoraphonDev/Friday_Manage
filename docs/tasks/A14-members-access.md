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

- [ ] test ครอบคลุมทุกข้อ
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- Admin Console (A18)
- Teams (A18)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
