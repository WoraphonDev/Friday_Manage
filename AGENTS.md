# AGENTS.md

Friday Manage: ระบบ Project Management สำหรับทีม Dev (ภาษาไทย) ที่จะเป็น SaaS แบบ multi-tenant · pnpm monorepo: `packages/db` (Drizzle + PostgreSQL 18 + RLS), `apps/api` (NestJS 11), `apps/web` (Next.js, งาน W00)

## ทำงานตาม Task

งานทั้งหมดอยู่ใน `docs/tasks/` · **อ่าน [docs/tasks/README.md](docs/tasks/README.md) ก่อนเริ่มทุกงาน**: กติกา lane ที่ทำให้หลาย agent ทำงานพร้อมกันได้โดยโค้ดไม่ทับกัน, ลำดับงาน และหน้าจอ → ไฟล์ Canvas

## รัน

- ฐานข้อมูล: `pnpm db:up && pnpm db:migrate && pnpm db:dev-roles` (Docker) · ไม่มี Docker / ไม่มี root (Codex): `bash scripts/setup-postgres.sh` ทำทั้งหมดให้และรันซ้ำได้ (เปิด PostgreSQL ใหม่ทุก session)
- `pnpm typecheck` · `pnpm test` (ใช้ฐานข้อมูลจริง รันทีละแพ็กเกจ)

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
- ข้อมูลใน test และตัวอย่างเป็นข้อมูลสมมติเท่านั้น · repo นี้เป็น Public
- Commit: หัวข้อภาษาอังกฤษแบบคำสั่ง (`Add comments and mentions`) · เนื้อหาเป็น bullet สั้น ๆ
