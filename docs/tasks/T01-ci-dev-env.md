# T01 · CI และสภาพแวดล้อมที่ไม่มี Docker

| | |
|---|---|
| Wave | 0 · ฐานราก (เริ่มก่อน) |
| รอ merge | — เริ่มได้เลย |
| Lane (แก้ได้เฉพาะ) | `.github/**` · `scripts/**` · `package.json` (ส่วน scripts ที่ราก) |
| หน้าจอ | — |
| สเปก | AGENTS.md › รัน |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `scripts/setup-postgres.sh` และ `scripts/codex-setup.sh` ใช้ได้แล้วบน Linux ที่ไม่มี root (ทดสอบใน container `node:22-bookworm` แบบ linux/amd64 ด้วยผู้ใช้ทั่วไป: test ผ่านทั้งหมด) · แก้เฉพาะเมื่อพังบน Codex
- GitHub Actions `.github/workflows/ci.yml` ทุก PR และ push เข้า main: pnpm install (cache) → service `postgres:18` พอร์ต 54329 ผู้ใช้ `friday_owner` → `pnpm db:migrate` → `pnpm db:dev-roles` → `pnpm typecheck` → `pnpm test` → `pnpm -r --if-present build`
- คำสั่งต้องไม่ผูกกับแพ็กเกจที่มีตอนนี้ (`pnpm -r`) เพื่อให้ `apps/web` และแอปใหม่เข้า CI เองโดยไม่ต้องแก้ไฟล์นี้

## กติกาที่ต้องตรง

- ไม่ format ไฟล์ทั้ง repo · ไม่เพิ่ม linter ที่ทำให้ไฟล์เดิมต้องแก้

## เสร็จเมื่อ

- [x] CI เขียวบน PR ของงานนี้

## ไม่อยู่ในงานนี้

- Deploy (งาน I01)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

- เพิ่ม `.github/workflows/ci.yml`: ทำงานทุก Pull Request และ push เข้า `main` โดยใช้ PostgreSQL 18 service ที่พอร์ต 54329 และรอ health check ก่อนเริ่ม
- ใช้ Node.js 22 และ pnpm ตาม `packageManager` ใน `package.json` พร้อม cache ตาม `pnpm-lock.yaml` และติดตั้งด้วย `--frozen-lockfile`
- ลำดับตรวจ: migrate → dev roles → `pnpm typecheck` → `pnpm test` (ทีละแพ็กเกจ) → `pnpm -r --if-present build` เพื่อรองรับแพ็กเกจที่จะเพิ่มในภายหลัง
- จำกัดสิทธิ์ workflow เป็น `contents: read`, timeout 20 นาที และยกเลิก run เก่าของ branch เดียวกันเมื่อมี commit ใหม่
- ไม่แก้สคริปต์ตั้ง environment เดิม เพราะงานนี้ยังไม่พบปัญหาบน Codex ตามเงื่อนไขของ task
- ตรวจในเครื่อง: YAML parse ผ่าน, `bash -n` ของสคริปต์เดิมผ่าน, migration / dev roles / typecheck / build ผ่าน และ test ผ่าน 78 ข้อ (DB 24 + API 54) · ข้าม 2 ข้อที่ต้องใช้ไฟล์แผนจริงซึ่งไม่ได้เก็บใน repo
- GitHub Actions ผ่านบน [PR #1](https://github.com/WoraphonDev/Friday_Manage/pull/1): [CI run #1](https://github.com/WoraphonDev/Friday_Manage/actions/runs/42046208737) ตรวจครบทุกขั้นตอนสำเร็จ · ไม่มีคำขอนอก lane
