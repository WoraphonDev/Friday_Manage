# A16 · คิวงานเบื้องหลัง (BullMQ + Valkey)

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | — เริ่มได้เลย |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/queue/**` · `apps/api/test/queue.e2e.test.ts` · `docker-compose.yml` · `scripts/setup-valkey.sh` · `apps/api/src/worker.ts` |
| หน้าจอ | — |
| สเปก | 03-api › 1 งานเบื้องหลัง (BullMQ) · docs/tech-stack.md |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- Valkey ใน `docker-compose.yml` และ `scripts/setup-valkey.sh` สำหรับเครื่องที่ไม่มี Docker
- `Jobs` service: `define(name, handler)`, `enqueue(name, data, opts)`, `every(name, cron)` · module อื่นเรียกใน `onModuleInit` ของตัวเอง
- โหมด `QUEUE_MODE=inline` (ค่าเริ่มต้นตอน test และเมื่อไม่มี `VALKEY_URL`): รันงานทันทีในโปรเซสเดียว ทำให้ test และ Codex ไม่ต้องมี Valkey
- Worker แยกโปรเซส `apps/api/src/worker.ts` + script `worker` ใน `apps/api/package.json`
- ตั้งเวลา `snapshotAll()` ของ A06 ทุกวัน 23:55 ถ้า A06 merge แล้ว

## กติกาที่ต้องตรง

- งานต้อง idempotent (รันซ้ำได้) · retry 3 ครั้งแบบ backoff

## เสร็จเมื่อ

- [x] test โหมด inline · test กับ Valkey จริงรันเมื่อตั้ง `VALKEY_URL`
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

- `Jobs` (`apps/api/src/queue/jobs.ts`) inject ได้ทุก module เพราะ `QueueModule` เป็น `@Global` · ไม่มี endpoint ใหม่
  - `define(name, handler)` · `enqueue(name, data, { jobId?, delayMs? })` คืน `{ jobId }` สำหรับตอบ `202` · `every(name, cron, data?)` ใช้เวลาไทย (`Asia/Bangkok`) และเรียกซ้ำได้ (upsert scheduler)
  - handler ได้ `(data, { id, name, attempt })` · ข้อมูลผ่าน JSON ทั้งสองโหมด (Date กลายเป็น string) เพื่อให้ inline กับ BullMQ ทำงานเหมือนกัน
  - retry: ครั้งแรก + retry 3 = 4 ครั้ง แบบ exponential เริ่ม 2 วินาที · โยน `UnrecoverableError` (export จาก `jobs.ts`) เพื่อหยุด retry · งานที่ล้มครบถูก log ไม่ทำให้ผู้เรียกล้ม
  - `jobId` กันงานซ้ำ (BullMQ ไม่เพิ่มงานที่ id ยังอยู่ในคิว · inline ไม่รันซ้อนถ้ากำลังรัน) และห้ามมี `:` ตามข้อจำกัดของ BullMQ
  - ประวัติงานใน Valkey: สำเร็จเก็บ 24 ชม. / 1,000 งาน · ล้มเก็บ 7 วัน
- เลือกโหมด: `QUEUE_MODE` ถ้าตั้ง · ไม่ตั้งแล้วใช้ `bullmq` เมื่อมี `VALKEY_URL` และไม่ใช่ test · นอกนั้น `inline` · `QUEUE_PREFIX` (ค่าเริ่มต้น `friday`) แยก key เมื่อใช้ Valkey ร่วมกัน
- โหมด inline รัน handler ทันทีใน `enqueue` (await) · retry ทันทีไม่รอ backoff · ไม่สน `delayMs` · `every` จำไว้ใน `jobs.scheduled` แต่ไม่รัน → **งานที่ต้อง enqueue หลัง commit** ไม่งั้น handler ที่อ่านผ่าน `SYSTEM_DB` จะไม่เห็นข้อมูล
- Worker: `apps/api/src/worker.ts` โหลด `AppModule` เดียวกับ API จึงเห็นทุกงานที่ define ใน `onModuleInit` · `pnpm --filter @friday/api worker` (หลัง build) หรือ `worker:dev` · `WORKER_CONCURRENCY` ค่าเริ่มต้น 5 · ไม่มี `VALKEY_URL` แล้วจบพร้อมข้อความบอกวิธีเปิด Valkey · SIGTERM ปิด Worker หลังงานที่รันอยู่เสร็จ
- Valkey 9.0: `docker compose up -d valkey` (พอร์ต 63799) หรือ `bash scripts/setup-valkey.sh` (ใช้ `valkey-server` ในเครื่องถ้ามี ไม่งั้น build 9.0.7 จาก source ไม่ต้องใช้ root) · ตั้ง `maxmemory-policy noeviction` ตามที่ BullMQ แนะนำ · Codex ไม่จำเป็นต้องเปิดเพราะ test ใช้ inline
- Library: `bullmq ~6.4.2` (ไม่เลือก 6.5–6.7 ที่ออกไม่ถึง 2 สัปดาห์) + `ioredis` เป็น client ที่ BullMQ 6 ต้องการ (peer dependency)
- ไม่ได้ตั้ง `snapshotAll()` ของ A06 เพราะ A06 ยังไม่ merge · A06 เรียกเองใน `onModuleInit`: `jobs.define('sprints.snapshot', () => this.snapshotAll())` แล้ว `await jobs.every('sprints.snapshot', '55 23 * * *')`
- Test `queue.e2e.test.ts` (17 ข้อ): inline 13 ข้อ (ใช้ฐานข้อมูลใน handler, JSON, retry, หยุดที่ 4 ครั้ง, UnrecoverableError, jobId ซ้อน, ชื่อ / cron / jobId ผิด, เลือกโหมด) · Valkey จริง 4 ข้อ รันเมื่อตั้ง `VALKEY_URL` (Worker คนละ instance, backoff, jobId ซ้ำ, scheduler เวลาไทย) · ผ่านทั้งสองแบบในเครื่อง
- `pnpm typecheck` และ `pnpm test` ผ่าน: DB 105 + API 67 (ข้าม 6: Valkey 4 เมื่อไม่ตั้ง `VALKEY_URL` + ไฟล์แผนจริง 2) + Web 31
- คำขอนอก lane:
  - T01: เพิ่ม service Valkey ใน `.github/workflows/ci.yml` และตั้ง `VALKEY_URL=redis://localhost:63799` ให้ test โหมด BullMQ รันใน CI · เพิ่ม script `queue:up` (`docker compose up -d valkey`) ใน `package.json` ที่ราก
  - `.env.example` (ไม่มีเจ้าของใน README): เพิ่ม `# VALKEY_URL=redis://localhost:63799` พร้อมคำอธิบายว่าไม่ตั้ง = inline
  - I01: deploy Worker เป็นโปรเซสแยก (`node dist/worker.js`) คู่กับ API และใช้ Valkey ที่ตั้ง `noeviction`

