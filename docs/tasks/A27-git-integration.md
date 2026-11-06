# A27 · เชื่อม GitHub: Commit / PR กับงาน

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | T00 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/git/**` · `apps/api/test/git.e2e.test.ts` · route `hooks/github*`, `w/integrations/git*`, `p/repositories`, `i/git` |
| หน้าจอ | C (`design/canvas/TaskDetail.dc.html`) · L2 (`design/canvas/ProjectSettings.dc.html`) · N1 (`design/canvas/AdminConsole.dc.html`) |
| สเปก | 03-api › 3.3 แถว integrations/git · 03-api › 3.5 แถว `p/repositories` · 03-api › 3.11 `/hooks/github` |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- ติดตั้ง GitHub App → `hooks/github/setup` · `GET / DELETE w/integrations/git`
- `POST hooks/github` (ตรวจลายเซ็น): ผูก Commit / PR จาก Issue key ใน branch, message, title · ย้ายสถานะตามกฎ `p/repositories` · CI ล้มเหลว → Event ให้ A23
- `CRUD p/repositories` · `GET i/git`

## เสร็จเมื่อ

- [x] test ด้วย payload ตัวอย่างของ GitHub (ข้อมูลสมมติ)
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- GitLab

## บันทึกผล

### Endpoint ที่เพิ่ม (`apps/api/src/git/`)

| Method | Path | สิทธิ์ | หมายเหตุ |
|---|---|---|---|
| GET | `w/:ws/integrations/git/install-url` | Owner / Admin | URL หน้าติดตั้ง GitHub App พร้อม `state` ที่ลงลายมือชื่อ (ผูก Workspace + ผู้กด · 15 นาที) · ยังไม่ตั้ง App ของระบบ → 409 `github_not_configured` |
| GET | `hooks/github/setup?installation_id&state&setup_action` | สาธารณะ (ตรวจ `state`) | Setup URL ของ App · บันทึกการติดตั้ง + ดึง repository → 302 ไป `{WEB_URL}/w/{slug}/admin/integrations?github=connected` (`setup_action=request` → `?github=pending`) · `state` ผิด / หมดอายุ → 400 · ผู้เริ่มไม่ใช่ Admin แล้ว → 403 · installation ของ Workspace อื่น → 409 |
| GET / DELETE | `w/:ws/integrations/git` · `/:id` | Owner / Admin | รายการติดตั้ง + repository (+ โปรเจกต์ที่ผูก) · DELETE ถอนฝั่ง Friday Manage (cascade การผูกโปรเจกต์) |
| GET | `w/:ws/integrations/git/:id/repositories` | Owner / Admin | |
| POST | `w/:ws/integrations/git/:id/sync` | Owner / Admin | ดึง repository ใหม่จาก GitHub · ที่ App เข้าไม่ถึงแล้วถูกเอาออก (เพิ่มจากสเปก) |
| GET / POST | `w/:ws/projects/:key/repositories` | อ่าน `project.view` (Guest ไม่ได้) · แก้ `project.settings` | ผูก repository พร้อม `branchPattern` (glob), `onFirstCommitStatusId`, `onPrOpenStatusId`, `onMergeStatusId` (ต้องอยู่ใน Workflow ของโปรเจกต์), `notifyOnCiFail` · GET คืน `available` ด้วย |
| PATCH / DELETE | `.../repositories/:id` | `project.settings` | |
| GET | `w/:ws/issues/:issueKey/git` | ดูงานได้ | `{ commits[], pullRequests[] }` พร้อม `linkedBy` (branch · message · title) |
| POST | `hooks/github` | ลายเซ็น `X-Hub-Signature-256` | HMAC-SHA256 ของ raw body ด้วย `GITHUB_WEBHOOK_SECRET` · ถูกต้อง → 202 `{ queued }` แล้วประมวลผลในคิว (`git.process`, jobId = delivery id กันซ้ำ) · ไม่ตั้ง secret → 503 · ข้าม CSRF (ดู A24) |

### การประมวลผล Event

- **ผู้เรียก/บริบท**: ประมวลผลด้วย SYSTEM_DB (ไม่มีผู้ใช้) เฉพาะ repository ที่อยู่ในการติดตั้งของ Workspace หนึ่งและโปรเจกต์ที่ผูกกับมัน · ทุก Event ทำซ้ำได้ผลเท่าเดิม (unique index ของ commit / PR / link)
- **`push`**: ผูก Commit กับงานจาก Issue key ใน message (`linkedBy: message`) และชื่อ branch (`branch`) เฉพาะ key ของโปรเจกต์ที่ผูกกับ repository นี้ · ไม่สนตัวพิมพ์ (`feature/dp-39-login` → DP-39) · branch ที่ไม่ตรง `branchPattern`, tag, การลบ branch ถูกข้าม
- **`pull_request`**: เก็บ PR (state `draft` · `open` · `merged` · `closed`) ผูกจาก title (`title`) และ branch (`branch`) · `synchronize` ล้างสถานะ CI
- **`pull_request_review`**: เก็บ `approved` / `changes_requested`
- **`check_run` · `check_suite` · `workflow_run`** (completed): `success` → `ci_status = success` · `failure` / `timed_out` / `startup_failure` / `action_required` → `failure` · ผลอื่นไม่เปลี่ยน
- **`installation`** (deleted → ลบการติดตั้ง, suspend / unsuspend) และ **`installation_repositories`** (added / removed) · การติดตั้งที่ suspend แล้วไม่ประมวลผล

### ย้ายสถานะตามกฎของโปรเจกต์

| เหตุการณ์ | ไปสถานะ |
|---|---|
| Commit **แรก** ที่ผูกกับงาน | `onFirstCommitStatusId` |
| เปิด PR / เปิดซ้ำ / พร้อม Review (ไม่ใช่ Draft) | `onPrOpenStatusId` |
| PR ถูก merge | `onMergeStatusId` |

- **ย้ายไปข้างหน้าเท่านั้น** (todo → in_progress → done) และต้องอยู่ Workflow เดียวกับสถานะปัจจุบัน: งานที่ไปไกลกว่าแล้วไม่ถูกดึงถอยหลัง · PR ที่ปิดโดยไม่ merge ไม่ย้าย · ตั้ง Actual Start / End / `completed_at` เหมือนการเปลี่ยนสถานะปกติ
- เขียน `activities` (`actor_kind = git`) และส่ง Event `issue.status_changed` (`data.via = git`) → Watcher ได้แจ้งผ่าน fan-out ของ A23

### CI ล้มเหลว

อัปเดต `pull_requests.ci_status` แล้วแจ้ง **Assignee** ของงานที่ผูกกับ PR (ไม่มี Assignee → PM = Project Owner) ผ่าน `Notifier` (eventType `ci.failed`, `dedupeKey` ต่อ repository + PR + commit จึงไม่แจ้งซ้ำ) และส่ง Event `ci.failed` (เพิ่มต่อท้าย `EventType`) ให้ Automation (A26) · เฉพาะโปรเจกต์ที่เปิด `notifyOnCiFail`

### คำตัดสินที่เลือกเอง

- **ใช้ GitHub App** ตามสเปก · env: `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` (PEM, ใส่ `\n` ได้), `GITHUB_WEBHOOK_SECRET` (ตั้งเป็นค่าเดียวทั้งระบบ) · เรียก GitHub แค่ตอน setup / sync (JWT RS256 ด้วย node:crypto ไม่เพิ่ม dependency)
- **ไม่เก็บ access token ของ installation** (ขอใหม่ทุกครั้งที่ต้องใช้ ใช้ได้ 1 ชม.) จึงไม่มี secret ของ GitHub ในฐานข้อมูลนอกจากที่ตั้งเป็น env
- แจ้ง CI ล้มเหลวผ่าน `Notifier` ตรง ๆ (ไม่ผ่าน fan-out ของ A23) เพราะ fan-out ยังไม่รู้จัก `ci.failed`
- ไม่ได้ทำ: GitLab (นอกงาน), ผูก Commit / PR กับงานด้วยมือ (`linkSource = manual` ยังไม่มี endpoint), map GitHub username → ผู้ใช้ (`author_user_id` เป็น null)

### คำขอนอก lane

- **A25** (`channels/message.ts`): เพิ่มหัวข้อ / สีของ `ci.failed` ("CI ของ PR ล้มเหลว") ตอนนี้ข้อความออกนอกแอปจะแสดงชื่อ eventType · **A23** (`notifications/rules.ts`): ถ้าต้องการให้ผู้ใช้ปิด/เปิด `ci.failed` ได้ในตารางแจ้งเตือน ให้เพิ่มแถวใน `me/prefs-catalog.ts` (A20)
- **I01**: ตั้ง Setup URL ของ GitHub App = `{API_PUBLIC_URL}/api/v1/hooks/github/setup` และ Webhook URL = `{API_PUBLIC_URL}/api/v1/hooks/github` (เปิด event: push, pull_request, pull_request_review, check_run, check_suite, workflow_run, installation, installation_repositories) · สิทธิ์ App: Contents (read), Pull requests (read), Checks (read), Metadata (read)
- **W13 / W18**: ปุ่ม Connect GitHub เรียก `install-url` แล้ว redirect · หน้า L2 Integrations ใช้ `p/repositories`

### ผล test

`apps/api/test/git.e2e.test.ts` 14 ข้อ (payload ตัวอย่างของ GitHub, GitHub API ปลอม): ดึง Issue key (ตัวพิมพ์เล็ก, ซ้ำ, ติดตัวอักษร) · ติดตั้ง (install-url, setup redirect + บันทึก repo + Audit, state ปลอม / หมดอายุ / ไม่ใช่ Admin / installation ของ Workspace อื่น, sync, ถอน) · ความปลอดภัย (ลายเซ็นผิด / ไม่มี, ไม่ตั้ง secret, ping, JSON เสีย) · ผูก repository (กฎสถานะ, สถานะนอก Workflow, ผูกซ้ำ, สิทธิ์) · push (message / branch, commit แรกย้ายสถานะ, ไม่ย้ายซ้ำ, payload ซ้ำไม่เกิดซ้ำ, branch pattern, repo ที่ไม่ผูก, ลบ branch, tag, ไม่ดึงถอยหลัง) · PR (เปิด / Draft / ready / merge / ปิดเฉยๆ) · CI (failure → แจ้ง Assignee ครั้งเดียว, success, cancelled ไม่เปลี่ยน, ปิดแจ้งเตือน, ไม่มี Assignee → PM) · review · installation events (เพิ่ม / เอาออก repo, suspend, deleted cascade) · Guest · `pnpm typecheck` ผ่าน · API ทั้งชุดผ่าน
