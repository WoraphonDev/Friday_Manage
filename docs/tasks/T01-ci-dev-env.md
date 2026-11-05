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

- ตรวจ `scripts/setup-postgres.sh` บน Ubuntu 24.04 ที่ไม่มี Docker (เช่น container `ubuntu:24.04` หรือ environment ของ Codex) จนได้ PostgreSQL 18 ที่ `pnpm test` ผ่าน · แก้สคริปต์ถ้าพัง
- GitHub Actions `.github/workflows/ci.yml` ทุก PR และ push เข้า main: pnpm install (cache) → service `postgres:18` พอร์ต 54329 ผู้ใช้ `friday_owner` → `pnpm db:migrate` → `pnpm db:dev-roles` → `pnpm typecheck` → `pnpm test` → `pnpm -r --if-present build`
- คำสั่งต้องไม่ผูกกับแพ็กเกจที่มีตอนนี้ (`pnpm -r`) เพื่อให้ `apps/web` และแอปใหม่เข้า CI เองโดยไม่ต้องแก้ไฟล์นี้
- เขียนวิธีตั้ง environment ของ Codex (setup script ที่ต้องใส่ในหน้า Environment) ใน "บันทึกผล" ของไฟล์นี้

## กติกาที่ต้องตรง

- ไม่ format ไฟล์ทั้ง repo · ไม่เพิ่ม linter ที่ทำให้ไฟล์เดิมต้องแก้

## เสร็จเมื่อ

- [ ] CI เขียวบน PR ของงานนี้
- [ ] บันทึกผลลัพธ์การรัน `scripts/setup-postgres.sh` บน Ubuntu เปล่า (log ช่วงท้าย) ไว้ใน "บันทึกผล"

## ไม่อยู่ในงานนี้

- Deploy (งาน I01)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
