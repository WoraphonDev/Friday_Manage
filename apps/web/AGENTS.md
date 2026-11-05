# Friday Web

- รัน `pnpm --filter @friday/web dev` ที่ http://127.0.0.1:3000 และ API `pnpm api:dev` ที่พอร์ต 3001 · `/api/v1` proxy ไป API เพื่อใช้ cookie ใน origin เดียว · เปลี่ยนปลายทางด้วย `API_ORIGIN`
- ตรวจ `pnpm --filter @friday/web typecheck`, `test`, `build` · UI kit เฉพาะ development ที่ `/dev/ui`
- เปิด production หลัง build ด้วย `pnpm --filter @friday/web start` (standalone พร้อม static assets) · ตั้ง `PORT` / `HOSTNAME` ได้ผ่าน environment
- หน้าตาใช้ Canvas v1.0.3 · token อยู่ `src/styles/tokens.css` · UI kit อยู่ `src/components/ui` · utility/API/Query/format อยู่ `src/lib`
- ข้อความแยก `messages/th/<namespace>.json` ต่องาน · server โหลดทุก namespace ในโฟลเดอร์นี้อัตโนมัติ · helper test เพิ่มข้อความเฉพาะงานผ่าน options ของ provider · ภาษาไทยเริ่มต้นและ timezone Asia/Bangkok
- ก่อนแก้ไฟล์อ่าน `docs/tasks/README.md` ที่ราก repo และ lane ของ task · หลัง W00 merge แก้เฉพาะ route/feature/namespace ของตนเอง · ใช้ `api` เพื่อส่ง CSRF, cookie และรับ ApiError · cache key ต้องมี Workspace/Project เพื่อไม่ปนกัน
- Test ใช้ `src/test/render.tsx` (Query+i18n+router) และ MSW ใน `src/test/server.ts` · fixture เป็นข้อมูลสมมติเท่านั้น
- Placeholder แทนด้วยหน้าของ task นั้นได้ · feature contract: `IssueDrawer({issueKey,onClose})`, `Bell({workspace,unread})`, `CommandPalette({workspace,open,onOpenChange})` · project layout ใช้ `?issue=KEY` และ `?new=1` สำหรับเปิดฟอร์มงาน

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
