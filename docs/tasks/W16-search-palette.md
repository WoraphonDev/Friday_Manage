# W16 · ค้นหาและ Command palette (Ctrl K)

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A22 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/w/[ws]/search/**` · `apps/web/src/features/command-palette/**` · `apps/web/messages/th/search-palette.json` |
| หน้าจอ | P1 (`design/canvas/Search.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · `GET w/search` (A22) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- หน้าค้นหาพร้อมตัวกรอง, palette ค้นงาน / โปรเจกต์ / คน / คำสั่ง, `#DP-39`, `@ชื่อ`, การค้นหาที่บันทึก

## เสร็จเมื่อ

- [ ] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [x] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [x] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

### หน้าและ API ที่ใช้

| ส่วน | ไฟล์ | API |
|---|---|---|
| Command palette (Ctrl K) | `src/features/command-palette/CommandPalette.tsx` (+ `palette.module.css`) | `GET w/:ws/search?q&limit=8` (`@ชื่อ` ส่ง `type=person` ด้วย) · `GET projects/:key/my-permissions` (cache เดียวกับ shell) |
| หน้าผลการค้นหา | `app/w/[ws]/search/page.tsx` · `_components/search-page.tsx` (+ `search.module.css`) | `GET w/:ws/search?q&limit=100&sort&project&archived[&type]` · `GET/POST w/:ws/saved-searches` · `DELETE w/:ws/saved-searches/:id` · `GET w/:ws/my-issues?tab=assigned` (ตัวกรอง "มอบหมายให้ฉัน") |
| ของที่ใช้ร่วมกัน | `src/features/command-palette/search-shared.tsx` | ชนิดผลค้นหา, ลิงก์ของแต่ละชนิด, `Highlight` (`<mark>`), ไอคอนตามชนิด, สถานะ |

- คง contract `CommandPalette({workspace,open,onOpenChange})` และไม่แก้ shell · ชื่อ dialog ("ค้นหาใน Workspace"), ช่องพิมพ์ ("ค้นหา") และปุ่มแว่นขยาย ("ค้นหา" ไปหน้าค้นหา) ใช้ข้อความเดิมใน `common` ทำให้ `shell.test.tsx` เดิมยังผ่าน
- Palette: ยังไม่พิมพ์ = "เปิดล่าสุด" (เก็บใน localStorage ต่อ Workspace สูงสุด 5) + "คำสั่งที่ใช้บ่อย" · พิมพ์แล้ว = กลุ่ม งาน / โปรเจกต์ / ไฟล์ และคอมเมนต์ / คน / คำสั่ง พร้อมจำนวนจาก `counts` · `>` = คำสั่งอย่างเดียว ไม่เรียก API · `#DP-39` / `dp-39` = แถว "เปิดงาน DP-39" ขึ้นทันทีแม้ผลยังไม่กลับมา (ถ้า API พบงานนั้นจะใช้แถวจากผลแทนและจัดขึ้นก่อน) · `@ชื่อ` = ค้นเฉพาะคน · ↑ ↓ Enter เปิด · Ctrl/Cmd Enter และปุ่ม "ค้นแบบละเอียด" ไปหน้าค้นหา · ถ้าอยู่ในโปรเจกต์ จะมีป้าย "ใน: ชื่อโปรเจกต์" และผลของโปรเจกต์นั้นขึ้นก่อน
- ลิงก์: งาน / คอมเมนต์ ไป `/w/:ws/p/:projectKey?issue=KEY` · โปรเจกต์ ไป `/p/:key` · ไฟล์ ไป `/p/:key/files` · คน ไป `/w/:ws/members`
- หน้าค้นหา: ตัวกรองประเภท (มีจำนวน), โปรเจกต์ (ทุกโปรเจกต์ หรือทีละโปรเจกต์), มอบหมายให้ฉัน, ยังไม่เสร็จ, รวม Archive และเรียงลำดับ · ตัวกรองเก็บใน URL (`q type project sort archived mine open`) · ผลแบ่งกลุ่มตามชนิด ไฮไลต์คำค้นและ snippet · การค้นหาที่บันทึก: แสดงในแผงตัวกรอง (คลิกแล้วใช้คำค้นและตัวกรองนั้น), ปุ่ม "บันทึกการค้นหานี้" (ตั้งชื่อได้ ตัวกรองเก็บใน `filters`), ลบผ่าน ConfirmDialog
- สถานะ: กำลังโหลด / ยังไม่มีคำค้น / ไม่พบ / Error พร้อม requestId / 403 ทั้งในหน้าและใน palette · Guest ไม่เห็นตัวกรอง "คน" และคำสั่งสร้างโปรเจกต์ / Import · "สร้างงานใหม่" แสดงเฉพาะเมื่อมี `issue.create` ใน `my-permissions`

### ต่างจากหน้าจอ / สเปก (คำตัดสินที่เลือกเอง)

- คำอธิบายใต้หัวข้อเขียน "ค้นทั้งชื่อ รายละเอียด คอมเมนต์ และชื่อไฟล์" แทน "ข้อความในไฟล์ (PDF, Word, Excel)" เพราะ A22 ยังไม่ค้นเนื้อหาไฟล์ (นอกขอบเขตตาม README)
- แถว "ลอง:" ใน Canvas เป็นคำค้นตัวอย่าง จึงทำเป็นปุ่มใส่ตัวนำหน้า `>` `#` `@` แทน · ไม่ใส่ "ดูคีย์ลัดทั้งหมด" และคีย์ลัด G M / G K เพราะ shell ยังไม่มีคีย์ลัดเหล่านี้ (แสดงเฉพาะ C ข้างคำสั่งสร้างงานตาม Canvas)
- API รับ `type` ได้ทีละชนิด หน้าค้นหาจึงขอทุกชนิดครั้งเดียว (ได้ `counts` ครบ) แล้วกรองประเภทในหน้า · ถ้าเลือกประเภทเดียวจะขอ `type=` เพิ่มเพื่อให้ได้ครบ 100 รายการ · ถ้าเกิน 100 จะแสดงหมายเหตุให้เพิ่มตัวกรอง
- "มอบหมายให้ฉัน" ใช้ `my-issues?tab=assigned` (A10) มาตัดผล เพราะผลค้นหาไม่มีผู้รับผิดชอบ · my-issues ไม่รวมงานที่เสร็จก่อนวันนี้ ตัวกรองนี้จึงไม่เจองานเก่าที่เสร็จแล้ว · "ยังไม่เสร็จ" ตัดงานที่หมวดสถานะเป็น `done` (ชนิดอื่นไม่ถูกตัด)
- มือถือ (390 px): palette เต็มจอและซ่อน meta ท้ายแถว · หน้าค้นหาวางแผงตัวกรองไว้เหนือผลลัพธ์

### คำขอนอก lane

- `src/i18n/messages.ts`: เพิ่ม namespace `search-palette` (palette อยู่ใน shell ทุกหน้า) · ตอนนี้เรียก `useTranslations("search-palette")` เฉพาะใน `PaletteBody` ที่ render ตอนเปิด test หน้าอื่นที่ไม่ได้เปิด palette จึงไม่มี MISSING_MESSAGE · ฝั่ง server โหลดทุก namespace อยู่แล้ว
- A22 (ถ้าต้องการ): ให้ `GET search` รับ `assignee=me`, `status=open` และ `type` หลายค่า หรือส่ง `assignees` มาในผลของงาน จะได้ไม่ต้องพึ่ง my-issues และกรองได้ครบเมื่อเกิน 100 รายการ

### ผล test

- `src/lib/search-palette.test.tsx` 15 ข้อ (MSW, ข้อมูลสมมติ): palette ตอนว่าง (เปิดล่าสุด + คำสั่ง + ปุ่มตัวนำหน้า) · กลุ่มผล + ไฮไลต์ + ↑↓ Enter + บันทึกเปิดล่าสุด · `#DE-39` ไป `?issue=DE-39` · `@ชื่อ` ส่ง `type=person` · `>` คำสั่งไม่เรียก API + ขอบเขตโปรเจกต์ · คำสั่งสร้างงานตามสิทธิ์ issue.create (มี / ไม่มี) · ไม่พบ → ค้นแบบละเอียด และ Ctrl Enter · Error มี requestId · หน้าค้นหา: กลุ่ม / จำนวน / ลิงก์ / สถานะ · ตัวกรองประเภท โปรเจกต์ Archive และการเรียง ส่งไป API และเก็บใน URL · ประเภทเดียว / ยังไม่เสร็จ / มอบหมายให้ฉัน · saved searches เปิด / บันทึก / ลบ · ว่าง / ไม่พบ / 500 / 403 · พิมพ์คำค้นใหม่
- `shell.test.tsx` เดิมผ่าน · `pnpm --filter @friday/web typecheck`, `test` (162 ข้อ), `build` ผ่าน
- ยังไม่ได้เทียบภาพกับ Canvas ที่ 1440/390 px
