# AGENTS.md

Friday Manage: ระบบ Project Management สำหรับทีม Dev (ภาษาไทย) ที่จะเป็น SaaS แบบ multi-tenant · pnpm monorepo: `packages/db` (Drizzle + PostgreSQL 18 + RLS), `apps/api` (NestJS 11), `apps/web` (Next.js, งาน W00)

## ทำงานตาม Task

งานทั้งหมดอยู่ใน `docs/tasks/` · **อ่าน [docs/tasks/README.md](docs/tasks/README.md) ก่อนเริ่มทุกงาน**: กติกา lane ที่ทำให้หลาย agent ทำงานพร้อมกันได้โดยโค้ดไม่ทับกัน, ลำดับงาน และหน้าจอ → ไฟล์ Canvas

## รัน

- ฐานข้อมูล: `pnpm db:up && pnpm db:migrate && pnpm db:dev-roles` (Docker) · ไม่มี Docker / ไม่มี root (Codex): `bash scripts/setup-postgres.sh` ทำทั้งหมดให้และรันซ้ำได้ (เปิด PostgreSQL ใหม่ทุก session)
- `pnpm typecheck` · `pnpm test` (ใช้ฐานข้อมูลจริง รันทีละแพ็กเกจ)

## ส่งงานและทดสอบผ่าน Docker ในเครื่อง

- ผู้ใช้กำหนดให้หลังแก้ไขเสร็จและผ่านการตรวจที่เกี่ยวข้อง ต้อง build แบบ production และ deploy เข้า Docker ในเครื่องก่อนส่งงาน เพื่อทดสอบใกล้เคียงการขึ้น server จริง
- Build จาก branch/commit ที่มีงานแก้ไขครบจริง แล้วรัน `docker compose -f infra/docker/compose.web.yml up --build -d` จากราก checkout นั้น · ไม่ใช้ image เก่าหรือ dev server เป็นผลทดสอบสุดท้าย
- ตรวจ container healthy, logs, หน้าเว็บ/static assets และ flow ที่แก้ไขผ่าน URL ของ container · งานเกี่ยวกับ auth/API/realtime ให้ตรวจการเชื่อมต่อจริงด้วย
- URL หลักคือ `http://localhost:3000` ให้ตรงกับ Origin ของ API · วิธีเปลี่ยนพอร์ตและ API origin อยู่ใน `infra/docker/web.md`
- ปัจจุบัน Compose นี้รันเฉพาะเว็บแบบ production ส่วน API ยังรันบนเครื่อง ถ้าแก้ API ต้อง build และเปิด API รุ่นที่แก้ไขด้วยก่อนทดสอบ ห้ามอ้างว่าทั้งระบบอยู่ใน Docker
- ใช้ฐานข้อมูลและข้อมูลทดสอบเดิม ห้ามล้าง volume หรือ reseed ทับข้อมูลเพื่อ deploy · ถ้า build/deploy/check ไม่ผ่าน ให้แก้ก่อนส่งงาน หรือระบุสิ่งที่ติดขัดตามจริง
- ตอนส่งงานแจ้ง URL, branch/commit ที่ deploy และผลตรวจโดยย่อ ไม่ต้องขออนุญาตซ้ำสำหรับการ build/deploy Docker ในเครื่องตามขั้นตอนนี้

## ที่มาของความจริง

- สเปก: `docs/spec/01-entities.md` (ตาราง), `03-api.md` (endpoint, error, event), `04-permissions.md` (สิทธิ์, Guest) · ธรรมเนียมการวางแผนขององค์กร: `docs/decisions.md`
- หน้าจอ: `design/canvas/*.dc.html` (UI v1.0.3 ล็อกแล้ว) · ทำให้ตรงกับหน้าจอ ถ้าสเปกกับหน้าจอขัดกัน ให้ยึดหน้าจอและบันทึกไว้ในไฟล์งาน
- โค้ดที่มีอยู่คือแบบอย่าง: `apps/api/src/issues`, `due-requests`, `views` และ `test/events.e2e.test.ts`

## ธรรมเนียมที่โค้ดไม่ได้บอก

- ชื่อในโค้ดเป็นอังกฤษ · คอมเมนต์, ข้อความ error และเอกสารเป็นภาษาไทยแบบที่มีอยู่ · คอมเมนต์อธิบาย "ทำไม" สั้น ๆ
- ทุก query ของลูกค้าผ่าน `TenantDb.run` เพื่อให้ RLS ทำงาน · ใช้ `SYSTEM_DB` (ข้าม RLS) เฉพาะตอนที่ยังไม่รู้ Workspace หรือเขียนแจ้งเตือน และเขียนเหตุผลไว้ในคอมเมนต์
- Error ใช้ `AppError(status, code, ข้อความไทย, details)` · คำเตือนที่ไม่บล็อกส่งใน `warnings: [{ code, message }]` · ตรวจข้อมูลขาเข้าด้วย zod + `parse()`
- สิทธิ์ใช้ `projectAccess` / `requirePerm` · ตัดข้อมูลของ Guest ที่ API ก่อนตอบ
- เหตุการณ์ (`issue.created` ฯลฯ) ส่งด้วย `EventBus.publish` หลัง commit · ผู้ฟังลงทะเบียนด้วย `EventBus.on` ใน `onModuleInit` ของ module ตัวเอง
- วันที่ในแผนเป็น `YYYY-MM-DD` · วันทำการใช้ `WorkCalendar` · วันนี้ใช้ `today()` (Asia/Bangkok) · Man-Day ตามธรรมเนียมใน `docs/decisions.md`
- สีทั้งหมดมาจาก token ใน `apps/web/src/styles/tokens.css` (ชุดสีตาม logo มีโหมดสว่าง/มืด ผู้ใช้เลือกแทนสีใน Canvas เมื่อ 2026-11-09) · ห้ามเขียน hex ใน CSS อื่น ต้องเพิ่ม token ทั้งสองโหมด (`src/lib/theme.test.tsx` ตรวจไว้) · สีที่ผู้ใช้เลือกเองใช้ `readableColor` / `tint` จาก `@/lib/colors`
- ข้อมูลใน test และตัวอย่างเป็นข้อมูลสมมติเท่านั้น · repo นี้เป็น Public
- Commit: หัวข้อภาษาอังกฤษแบบคำสั่ง (`Add comments and mentions`) · เนื้อหาเป็น bullet สั้น ๆ
