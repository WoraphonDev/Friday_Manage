# งานที่เหลือของ Friday Manage (สำหรับ Codex)

แบ่งเป็นงานย่อย 59 งาน + Friday Ops เฟส 1 อีก 17 งาน · 1 งาน = 1 branch = 1 PR · หลาย agent ทำพร้อมกันได้เพราะแต่ละงานมี **lane** ของตัวเอง: รายการไฟล์ที่งานนั้นแก้ได้ ไม่ทับกับงานอื่น · อ่านได้ทุกไฟล์ใน repo

## ขั้นตอน

1. เลือกงานที่ทุกงานในช่อง "รอ merge" อยู่ใน main แล้ว และไม่มี PR อื่นเปิดอยู่ใน lane เดียวกัน
2. สร้าง branch `task/<ID>-<slug>` จาก main ล่าสุด
3. แก้เฉพาะไฟล์ใน lane ของงาน (ดู "Lane" และ "ไฟล์กลาง" ด้านล่าง)
4. ทำจนทุกข้อใน "เสร็จเมื่อ" ของไฟล์งานติ๊กได้จริง
5. เขียน "บันทึกผล" ในไฟล์งานของตัวเอง แล้วติ๊ก checkbox ที่ผ่าน
6. rebase บน main ล่าสุด รัน `pnpm typecheck` และ `pnpm test` อีกรอบ แล้วเปิด PR ชื่อ `[<ID>] <ชื่องาน>`

## Lane

- API: แต่ละโฟลเดอร์ใน `apps/api/src/` เป็น Nest module ที่ลงทะเบียนใน `app.module.ts` ไว้แล้ว (มี module ว่างรอทุกงาน) · ใส่ controller / provider ใน `<lane>.module.ts` ของตัวเอง · route ไม่ต้องขึ้นต้นตามชื่อโฟลเดอร์
- Test ของ API: ไฟล์ของตัวเอง `apps/api/test/<lane>.e2e.test.ts` เริ่มด้วย `startApp()` + `seedTeam()` จาก `test/helpers.ts` (ดูแบบใน `test/events.e2e.test.ts`) · ทุกไฟล์เริ่มจากฐานข้อมูลว่างและรันทีละไฟล์
- หน้าเว็บ: lane = โฟลเดอร์ของเส้นทางในตาราง "เส้นทางของหน้าเว็บ" + `src/features/<ชื่อ>/` ที่ระบุ + `messages/th/<slug>.json` · component ที่ใช้เฉพาะหน้าวางใน `_components/` ของเส้นทางตัวเอง
- ใช้ของที่อยู่นอก lane ได้ (import, เรียก method) · ถ้าต้องแก้ไฟล์นอก lane: เขียนเป็น "คำขอนอก lane" ในบันทึกผล ทำทางเลี่ยงใน lane ตัวเองถ้าทำได้ ถ้าทำไม่ได้ให้เว้นส่วนนั้นและบอกไว้
- Schema ของฐานข้อมูลเปลี่ยนได้เฉพาะงาน T00 · งานอื่นที่ต้องการตาราง / คอลัมน์เพิ่ม เขียนเป็นคำขอนอก lane

## ไฟล์กลาง

| ไฟล์ | ใครแก้ได้ |
|---|---|
| `apps/api/src/app.module.ts`, `core/core.module.ts`, `common/**`, `db/**`, `due-requests/**`, `views/**` | ไม่มีใคร (เสร็จแล้ว / ใช้ร่วมกัน) · helper ใหม่ให้เขียนใน lane ตัวเอง |
| `apps/api/src/core/events.ts` | ทุกงาน แต่เพิ่ม Event ใหม่ต่อท้าย union `EventType` เท่านั้น |
| `apps/api/src/core/plan-limits.ts` | A29 |
| `apps/api/src/core/mail.ts` | A25 |
| `apps/api/src/issues/**` (รวม `IssuesService` ที่ทุกงานใช้) | A03 · งานอื่นเรียก method ที่มีอยู่ |
| `apps/api/src/projects/**` (รวม `permissions.ts`, `calendar.ts`) | A04 |
| `apps/api/src/notifications/**` (รวม `notifier.ts`) | A23 |
| `apps/api/src/auth/**` | A13 แล้วต่อด้วย A28 |
| `apps/api/src/bootstrap.ts` · `main.ts` | A17 · I01 |
| `apps/api/test/helpers.ts`, `api.e2e.test.ts`, `events.e2e.test.ts` | ไม่มีใคร |
| `packages/db/**` | T00 · O00 (Friday Ops เฟส 1) |
| `docker-compose.yml` | A16 |
| `.github/**`, `scripts/**`, `package.json` ที่ราก | T01 (ยกเว้น `scripts/setup-valkey.sh` ของ A16) |
| `apps/*/package.json`, `pnpm-lock.yaml` | ทุกงานเพิ่ม dependency ได้เมื่อจำเป็น · ชนกันตอน rebase: เก็บของทั้งสองฝั่งแล้วรัน `pnpm install` |
| `apps/web/src/components/ui/**`, `src/lib/**`, `app/work/[ws]/layout.tsx`, `app/work/[ws]/p/[key]/layout.tsx`, `messages/th/common.json` | W00 · งานอื่นเพิ่มไฟล์ใหม่ได้ |
| `docs/spec/**`, `README.md` ทุกไฟล์, `docs/decisions.md` | D99 · งานอื่นเขียนในบันทึกผลของตัวเอง |
| `docs/tasks/<ID>-*.md` | งานนั้น (เฉพาะบันทึกผลและ checkbox) |
| `design/**` | อ่านอย่างเดียว |

## เส้นทางของหน้าเว็บ

ทุกเส้นทางอยู่ใต้ `apps/web/app/` · W00 สร้างเป็น placeholder ไว้ก่อน

| เส้นทาง | งาน |
|---|---|
| `(auth)/login`, `signup`, `forgot-password`, `join/[token]`, `onboarding` | W01 |
| `(public)/` (Landing, ราคา, `legal/[type]`) · `w/[ws]/billing/**` | W19 |
| `w/[ws]/` (Home) · `w/[ws]/my-tasks` | W03 |
| `w/[ws]/inbox` · `src/features/bell` | W04 |
| `w/[ws]/search` · `src/features/command-palette` | W16 |
| `w/[ws]/profile` | W17 |
| `w/[ws]/members` · `w/[ws]/p/[key]/members` | W10 |
| `w/[ws]/admin/**` · `w/[ws]/p/[key]/automation` | W18 |
| `w/[ws]/new-project` · `w/[ws]/p/[key]/settings/**` | W13 |
| `w/[ws]/import` · `w/[ws]/p/[key]/plan-changes` | W14 |
| `w/[ws]/p/[key]/` (Overview) · `table` | W05 |
| `w/[ws]/p/[key]/board` | W06 |
| `w/[ws]/p/[key]/timeline` | W07 |
| `w/[ws]/p/[key]/gantt` | W08 |
| `w/[ws]/p/[key]/calendar` | W09 |
| `w/[ws]/p/[key]/files` | W11 |
| `w/[ws]/p/[key]/backlog` | W12 |
| `w/[ws]/p/[key]/dashboard` · `reports` | W15 |
| `src/features/issue-drawer` (เปิดจากทุกหน้าในโปรเจกต์ด้วย `?issue=DP-39`) | W02 |

หน้ามือถือ (M2–M7) ทำในงานของหน้าเดียวกันบน desktop · สถานะหน้าจอ (M1) อยู่ใน UI kit ของ W00

## ลำดับ

- **Wave 0** เริ่มพร้อมกันได้ 3 งาน: T00 (ตาราง), T01 (CI), W00 (โครงเว็บ)
- **Wave 1** API ที่ใช้ตารางเดิม เริ่มได้ทันทีพร้อม Wave 0 · หน้าเว็บเริ่มหลัง W00 merge และเมื่อ API ที่หน้านั้นใช้ merge แล้ว (ดูช่อง "รอ merge")
- **Wave 2** รอ T00 หรืองานที่ระบุ
- **Wave 3** ปิดท้าย: OpenAPI, Deploy, รวมเอกสาร, ภาษาอังกฤษ

ยังไม่วางเป็นงาน (รอผู้ใช้สั่ง): SSO / SAML, เชื่อมระบบ HR (`/hooks/hr`), Gantt PDF, ค้นหาข้อความในไฟล์, GitLab

## งานทั้งหมด

| งาน | ชื่อ | Wave | รอ merge | Lane หลัก |
|---|---|---|---|---|
| [T00](T00-db-schema-rest.md) | ตารางที่เหลือทั้งหมด + RLS | 0 | — | `packages/db/**` |
| [T01](T01-ci-dev-env.md) | CI และสภาพแวดล้อมที่ไม่มี Docker | 0 | — | `.github/**` · `scripts/**` |
| [W00](W00-web-scaffold.md) | โครงเว็บ Next.js: Design system, API client, Shell, เส้นทางทุกหน้า | 0 | — | `apps/web/**` (ทั้งหมด จนกว่างานนี้ merge · หลังจากนั้นแบ่งตามตาราง "เส้นทางของหน้าเว็บ" ใน README) |
| [A01](A01-comments-watch-activity.md) | คอมเมนต์, @mention, Watch และ Activity ของงาน | 1 | — | `apps/api/src/comments/**` · `apps/api/test/comments.e2e.test.ts` |
| [A02](A02-checklist-dependencies.md) | Checklist, Acceptance criteria และ Dependency | 1 | — | `apps/api/src/issue-parts/**` · `apps/api/test/issue-parts.e2e.test.ts` |
| [A03](A03-issue-lifecycle-table.md) | วงจรชีวิตงาน: ลบ / กู้คืน, Bulk, Reopen, Assignees, ตัวกรอง Table, form-options | 1 | — | `apps/api/src/issues/**` · `apps/api/test/issues.e2e.test.ts` |
| [A05](A05-project-structure.md) | โครงสร้างโปรเจกต์: Module, กลุ่มงาน, Milestone, Workflow, ประเภทงาน, Field, Label, วันหยุด | 1 | — | `apps/api/src/project-structure/**` · `apps/api/test/project-structure.e2e.test.ts` |
| [A06](A06-sprints-backlog.md) | Sprint และ Backlog | 1 | — | `apps/api/src/sprints/**` · `apps/api/test/sprints.e2e.test.ts` |
| [A07](A07-gantt-baselines.md) | Gantt, Baseline, การแก้ไขแผน และ Auto-schedule | 1 | — | `apps/api/src/gantt/**` · `apps/api/test/gantt.e2e.test.ts` |
| [A08](A08-overview-workload.md) | Overview โปรเจกต์ และ Workload | 1 | — | `apps/api/src/overview/**` · `apps/api/test/overview.e2e.test.ts` |
| [A10](A10-home-my-tasks.md) | Home และ My Tasks | 1 | — | `apps/api/src/home/**` · `apps/api/test/home.e2e.test.ts` |
| [A11](A11-files.md) | ไฟล์, โฟลเดอร์, เวอร์ชัน และไฟล์แนบ | 1 | — | `apps/api/src/files/**` · `apps/api/test/files.e2e.test.ts` |
| [A12](A12-test-runs-time-logs.md) | ผลทดสอบ, สร้าง Bug จากผลทดสอบ และบันทึกเวลา | 1 | — | `apps/api/src/qa/**` · `apps/api/test/qa.e2e.test.ts` |
| [A13](A13-auth-extras.md) | ยืนยันอีเมล, ลืมรหัสผ่าน, 2FA, Google / Microsoft, Session | 1 | — | `apps/api/src/auth/**` · `apps/api/test/auth.e2e.test.ts` |
| [A14](A14-members-access.md) | สมาชิก Workspace, ลิงก์เชิญ และคำขอเข้าร่วม | 1 | — | `apps/api/src/workspaces/**` · `apps/api/test/members.e2e.test.ts` |
| [A15](A15-import-update-export.md) | Import Excel โหมดอัปเดตแผน และ Export | 1 | — | `apps/api/src/imports/**` · `apps/api/test/imports.e2e.test.ts` |
| [A16](A16-queue.md) | คิวงานเบื้องหลัง (BullMQ + Valkey) | 1 | — | `apps/api/src/queue/**` · `apps/api/test/queue.e2e.test.ts` |
| [A17](A17-realtime.md) | Realtime (WebSocket) | 1 | — | `apps/api/src/realtime/**` · `apps/api/test/realtime.e2e.test.ts` |
| [W01](W01-auth-onboarding.md) | Login, สมัคร, ลืมรหัสผ่าน, รับคำเชิญ, Onboarding | 1 | W00, A13 | `apps/web/app/(auth)/**` · `apps/web/messages/th/auth-onboarding.json` |
| [W02](W02-issue-drawer.md) | Drawer งาน (Task / Sub-task / Bug), ฟอร์มสร้างงาน, ขอเลื่อน Due, Dialog ยืนยัน | 1 | W00, A01, A02, A03 | `apps/web/src/features/issue-drawer/**` · `apps/web/messages/th/issue-drawer.json` |
| [W03](W03-home-my-tasks.md) | Home และ My Tasks (รวมมือถือ) | 1 | W00, A10 | `apps/web/app/work/[ws]/page.tsx` · `apps/web/app/work/[ws]/my-tasks/**` |
| [W04](W04-inbox-bell.md) | Inbox และกระดิ่ง | 1 | W00 | `apps/web/app/work/[ws]/inbox/**` · `apps/web/src/features/bell/**` |
| [W05](W05-overview-table.md) | Overview และ Table ของโปรเจกต์ | 1 | W00, A03, A08 | `apps/web/app/work/[ws]/p/[key]/page.tsx` · `apps/web/app/work/[ws]/p/[key]/table/**` |
| [W06](W06-kanban.md) | Kanban (รวมมือถือ) | 1 | W00 | `apps/web/app/work/[ws]/p/[key]/board/**` · `apps/web/messages/th/kanban.json` |
| [W07](W07-timeline.md) | Timeline (SVG เขียนเอง) | 1 | W00 | `apps/web/app/work/[ws]/p/[key]/timeline/**` · `apps/web/messages/th/timeline.json` |
| [W08](W08-gantt.md) | Gantt (SVG เขียนเอง) | 1 | W00, A07, A02 | `apps/web/app/work/[ws]/p/[key]/gantt/**` · `apps/web/messages/th/gantt.json` |
| [W09](W09-calendar.md) | Calendar | 1 | W00, A21 | `apps/web/app/work/[ws]/p/[key]/calendar/**` · `apps/web/messages/th/calendar.json` |
| [W10](W10-members-workload.md) | สมาชิกโปรเจกต์ + Workload และสมาชิก Workspace | 1 | W00, A04, A08, A14 | `apps/web/app/work/[ws]/p/[key]/members/**` · `apps/web/app/work/[ws]/members/**` |
| [W11](W11-files.md) | Files | 1 | W00, A11 | `apps/web/app/work/[ws]/p/[key]/files/**` · `apps/web/messages/th/files.json` |
| [W12](W12-backlog.md) | Backlog + Sprint planning | 1 | W00, A06 | `apps/web/app/work/[ws]/p/[key]/backlog/**` · `apps/web/messages/th/backlog.json` |
| [W13](W13-project-settings-new.md) | Project Settings และสร้างโปรเจกต์ (Wizard) | 1 | W00, A04, A05 | `apps/web/app/work/[ws]/p/[key]/settings/**` · `apps/web/app/work/[ws]/new-project/**` |
| [W14](W14-import-plan-changes.md) | Import Excel และการแก้ไขแผน | 1 | W00, A07 | `apps/web/app/work/[ws]/import/**` · `apps/web/app/work/[ws]/p/[key]/plan-changes/**` |
| [W15](W15-lead-dashboard-reports.md) | Lead Dashboard และ Reports | 1 | W00, A09 | `apps/web/app/work/[ws]/p/[key]/dashboard/**` · `apps/web/app/work/[ws]/p/[key]/reports/**` |
| [W16](W16-search-palette.md) | ค้นหาและ Command palette (Ctrl K) | 1 | W00, A22 | `apps/web/app/work/[ws]/search/**` · `apps/web/src/features/command-palette/**` |
| [W17](W17-profile.md) | Profile และการตั้งค่าแจ้งเตือนของฉัน | 1 | W00, A13, A20 | `apps/web/app/work/[ws]/profile/**` · `apps/web/messages/th/profile.json` |
| [W18](W18-admin-automation.md) | Admin Console, หน้าตาข้อความแจ้งเตือน และ Automation | 1 | W00, A18 | `apps/web/app/work/[ws]/admin/**` · `apps/web/app/work/[ws]/p/[key]/automation/**` |
| [W19](W19-saas-pages.md) | Landing, ราคา, ชำระเงิน, เกินแพ็กเกจ, กฎหมาย + Cookie | 1 | W00, A29, A30 | `apps/web/app/(public)/**` · `apps/web/app/work/[ws]/billing/**` |
| [W20](W20-ops-web.md) | หน้าเว็บหลังบ้านทีม Friday | 1 | W00, A32 | `apps/ops-web/**` |
| [A04](A04-project-core.md) | ข้อมูลโปรเจกต์, สมาชิกโปรเจกต์, Archive / โอน / ลบ, Template | 2 | T00 | `apps/api/src/projects/**` · `apps/api/test/projects.e2e.test.ts` |
| [A09](A09-lead-dashboard-reports.md) | Lead Dashboard และ Reports | 2 | A08 | `apps/api/src/reports/**` · `apps/api/test/reports.e2e.test.ts` |
| [A18](A18-admin-console.md) | Admin Console ของ Workspace | 2 | T00, A05 | `apps/api/src/admin/**` · `apps/api/test/admin.e2e.test.ts` |
| [A20](A20-profile-prefs-leaves.md) | Profile, การตั้งค่าแจ้งเตือนของฉัน และวันลา | 2 | T00 | `apps/api/src/me/**` · `apps/api/test/profile.e2e.test.ts` |
| [A21](A21-calendar-ical.md) | ปฏิทินโปรเจกต์ และ iCal | 2 | T00 | `apps/api/src/calendar/**` · `apps/api/test/calendar.e2e.test.ts` |
| [A22](A22-search-saved-views.md) | ค้นหา, การค้นหาที่บันทึก และ View ที่บันทึก | 2 | T00 | `apps/api/src/search/**` · `apps/api/test/search.e2e.test.ts` |
| [A23](A23-notification-fanout.md) | กระจายแจ้งเตือนจาก Event และแจ้งเตือนตามเวลา | 2 | T00, A16 | `apps/api/src/notifications/**` · `apps/api/test/notification-fanout.e2e.test.ts` |
| [A24](A24-line-oa.md) | LINE OA: ผูกบัญชี, กลุ่ม และปุ่มอนุมัติคำขอเลื่อน Due | 2 | A25 | `apps/api/src/line/**` · `apps/api/test/line.e2e.test.ts` |
| [A25](A25-channels-email-webhook.md) | ส่งแจ้งเตือนออกนอกแอป: Email, Webhook และกฎของโปรเจกต์ | 2 | T00, A16, A23 | `apps/api/src/channels/**` · `apps/api/test/channels.e2e.test.ts` |
| [A26](A26-automation.md) | Automation (เมื่อ … ถ้า … ให้ …) | 2 | T00, A16, A03 | `apps/api/src/automation/**` · `apps/api/test/automation.e2e.test.ts` |
| [A27](A27-git-integration.md) | เชื่อม GitHub: Commit / PR กับงาน | 2 | T00 | `apps/api/src/git/**` · `apps/api/test/git.e2e.test.ts` |
| [A28](A28-api-tokens.md) | API token (Bearer) | 2 | T00, A13 | `apps/api/src/auth/**` · `apps/api/test/api-tokens.e2e.test.ts` |
| [A29](A29-plans-limits.md) | แพ็กเกจ, ขีดจำกัด (402) และใบเสนอราคา | 2 | T00 | `apps/api/src/billing/**` · `apps/api/test/plans.e2e.test.ts` |
| [A30](A30-public-legal.md) | หน้าสาธารณะ: แพ็กเกจและเอกสารกฎหมาย | 2 | T00 | `apps/api/src/public/**` · `apps/api/test/public.e2e.test.ts` |
| [A31](A31-privacy-export.md) | PDPA, Export ข้อมูล Workspace, สิทธิ์ทีม Friday, ลบ Workspace | 2 | T00, A16, A29 | `apps/api/src/privacy/**` · `apps/api/test/privacy.e2e.test.ts` |
| [A32](A32-ops-api.md) | หลังบ้านทีม Friday (แอปแยก) | 2 | T00, A29 | `apps/ops-api/**` (แอปใหม่) |
| [A33](A33-payments.md) | ชำระเงิน: บัตร, PromptPay, โอน, ใบกำกับภาษี, 50 ทวิ | 2 | A29 | `apps/api/src/payments/**` · `apps/api/test/payments.e2e.test.ts` |
| [A40](A40-openapi.md) | OpenAPI ของทุก endpoint | 3 | ทุกงาน A | ทุก controller ใน `apps/api/src/**` (ทำตอนไม่มีงาน API อื่นเปิดอยู่) |
| [D99](D99-docs-sync.md) | รวมบันทึกผลเข้าเอกสาร | 3 | ทุกงาน | `apps/api/README.md` · `docs/spec/**` |
| [I01](I01-deploy-aws.md) | Deploy บน AWS + GlitchTip | 3 | T01 | `infra/**` · `Dockerfile*` |
| [W21](W21-english.md) | ภาษาอังกฤษ (EN) | 3 | W00, ทุกงาน W | `apps/web/messages/en/**` · `apps/web/src/features/locale-switch/**` |

## Friday Ops เฟส 1 (ออกแบบใหม่ 9 พ.ย. 2569)

หน้าจอ: `design/canvas/ops/` (สำเนาของ [Canvas Friday Ops](https://claude.ai/artifact/Q8tsmLfQqS1aUJ2rNrkw9r) รุ่นที่ 40) · ทำเฉพาะสิ่งที่ติดป้าย **เฟส 1** · สเปก: [05-business-metrics](../spec/05-business-metrics.md), [06-ops-roles](../spec/06-ops-roles.md) · คำตัดสิน: [decisions.md](../decisions.md) › "Friday Ops: บทบาทพนักงาน"

แทนหน้าจอเดิมของ A32 / W20 (ของเดิมใช้ต่อได้ แต่ต้องปรับตามดีไซน์ใหม่) · ลำดับ: O00 → O01, A34 และ A35a → O02–O06, O10 และ W22 → หน้าเว็บ O11–O15 · A35b เริ่มเมื่อผู้ใช้เลือก Gateway

| งาน | ชื่อ | Wave | รอ merge | Lane หลัก |
|---|---|---|---|---|
| [O00](O00-ops-db-phase1.md) | ตารางของ Friday Ops เฟส 1 และข้อมูลธุรกิจ | O-0 | — | `packages/db/**` |
| [O01](O01-ops-roles-approvals.md) | ops-api: แยก module, บทบาท, วงเงิน, อนุมัติ, สิทธิ์ฉุกเฉิน, พนักงาน | O-1 | O00 | `apps/ops-api/src/{auth,staff,approvals}` + `ops.controller.ts` |
| [A34](A34-analytics-collection.md) | API: เก็บข้อมูลธุรกิจตั้งแต่วันแรก | O-1 | O00 | `apps/api/src/analytics/**` |
| [A35a](A35a-payments-core.md) | API: แกนการชำระเงิน · VAT เป็นการตั้งค่า · สลิปให้ทีมตรวจ · ตัวจำลองผู้ให้บริการ | O-1 | O00 | `apps/api/src/payments/**` (ยกเว้น `providers/`) |
| [A35b](A35b-payments-gateway.md) | API: ต่อ Gateway จริง · **รอเลือก Opn หรือ Stripe** | O-1 | A35a | `apps/api/src/payments/providers/**` |
| [W22](W22-checkout.md) | เว็บ: หน้าชำระเงินฝั่งลูกค้าและแบบสอบถามตอนยกเลิก | O-1 | A35a | `apps/web/app/work/[ws]/billing/checkout/**` |
| [O02](O02-ops-customers.md) | ops-api: ลูกค้าและผู้ใช้ | O-2 | O01 | `apps/ops-api/src/{workspaces,users}` |
| [O03](O03-ops-money.md) | ops-api: เงิน | O-2 | O01, A35a | `apps/ops-api/src/{payments,billing}` |
| [O04](O04-ops-support-system.md) | ops-api: Ticket สถานะระบบ เหตุขัดข้อง | O-2 | O01 | `apps/ops-api/src/{support,system}` |
| [O05](O05-ops-privacy-legal.md) | ops-api: PDPA และเอกสารกฎหมาย | O-2 | O01 | `apps/ops-api/src/{privacy,legal}` |
| [O06](O06-ops-metrics.md) | ops-api: ภาพรวม และธุรกิจและกำไร | O-2 | O01, A34 | `apps/ops-api/src/metrics` |
| [O10](O10-ops-web-shell.md) | ops-web: Shell, เข้าสู่ระบบ, ชิ้นส่วนมาตรฐาน, Modal กลาง, พนักงาน | O-2 | O01 | `apps/ops-web/src/components` + layout, login, staff |
| [O11](O11-ops-web-customers.md) | ops-web: Workspaces, รายละเอียดลูกค้า, ผู้ใช้ | O-3 | O10, O02 | `apps/ops-web/app/(console)/{workspaces,users}` |
| [O12](O12-ops-web-money.md) | ops-web: รายได้และการชำระเงิน, คืนเงิน | O-3 | O10, O03 | `apps/ops-web/app/(console)/{payments,refunds}` |
| [O13](O13-ops-web-support-system.md) | ops-web: Ticket, สถานะระบบ, เหตุขัดข้อง | O-3 | O10, O04 | `apps/ops-web/app/(console)/{support,system,incidents}` |
| [O14](O14-ops-web-privacy-legal.md) | ops-web: PDPA, เอกสารกฎหมาย | O-3 | O10, O05 | `apps/ops-web/app/(console)/{privacy,legal}` |
| [O15](O15-ops-web-overview-business.md) | ops-web: ภาพรวม, ธุรกิจและกำไร | O-3 | O10, O06 | `apps/ops-web/app/(console)/{page.tsx,business}` |

ไฟล์กลางของ ops: `apps/ops-api/src/app.module.ts` และ `ops.controller.ts` แก้ได้เฉพาะ O01 (งานอื่นลงทะเบียน module ผ่านคำขอนอก lane หรือ O01 เตรียม module ว่างไว้ให้) · `apps/ops-web/src/components/**`, `app/layout.tsx`, `app/(console)/layout.tsx` แก้ได้เฉพาะ O10 · `apps/ops-api/test/helpers.ts` แก้ได้เฉพาะ O01 (เพิ่ม `staff(…, roles[])` และ `reauth()` ไว้ให้งานอื่นใช้)

## ตั้ง environment ของ Codex

ตั้งไว้แล้วที่ chatgpt.com/codex › Environment `Friday_Manage` · Codex ไม่มี root, ไม่มี Docker และ home ของผู้ใช้ไม่มีอยู่จริง

- Install script: `bash scripts/codex-setup.sh` (pnpm install + PostgreSQL 18 จาก npm ไม่ต้องใช้ root)
- Environment variables: `XDG_DATA_HOME=/workspace/.local/share` · `XDG_CACHE_HOME=/workspace/.cache` · `XDG_CONFIG_HOME=/workspace/.config` · `COREPACK_HOME=/workspace/.cache/corepack` · `npm_config_cache=/workspace/.cache/npm`
- ทุก session เริ่มด้วย `bash scripts/setup-postgres.sh` (เปิดเซิร์ฟเวอร์ที่หยุดไปตอน container ถูกเก็บ)
