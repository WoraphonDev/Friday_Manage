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

- [ ] test โหมด inline · test กับ Valkey จริงรันเมื่อตั้ง `VALKEY_URL`
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
