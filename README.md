# Friday Manage

ระบบ Project Management สำหรับทีมพัฒนาซอฟต์แวร์ วางแผนเป็น Module › กลุ่มงาน › Task › Sub-task ประเมินงานเป็น Man-Day และติดตามแผนเทียบกับงานจริง (Plan vs Actual)

## สถานะปัจจุบัน

**UI v1.0 ล็อกแล้ว (5 พ.ย. 2569) · สเปกร่างแรกครบ · เริ่มโค้ดส่วนฐานข้อมูลแล้ว**

แนวทางของโปรเจกต์คือ **ให้ UI ผ่านการ Review ก่อน แล้วค่อยถอดสเปก API และฐานข้อมูลจากหน้าจอ**

| รอบ | ข้อมูลในหน้าจอ | ผล |
|---|---|---|
| Review รอบ 1 | ข้อมูลสมมติ | ความง่ายเฉลี่ย 3 / 5 · ทีมบอกว่าข้อมูลไม่ใช่งานจริง จึงตัดสินได้ยาก |
| Review รอบ 2 | แผนงานจริง Development Plan 2026-11 (334 งาน) · สถานะจำลอง ณ 2 ธ.ค. 2569 | ทีมยอมรับ UI ปัจจุบัน → ล็อกเป็น v1.0 |

- Prototype ที่คลิกได้ (Canvas): https://claude.ai/artifact/7S2UHYDoxaNawnV4BGmPCa
- เริ่มที่หน้า **"0 · เริ่มที่นี่ — คู่มือ Review"** ซึ่งมี 6 สถานการณ์ทดสอบแยกตามบทบาท

## โครงสร้าง repo

```
packages/db/      Schema ของ PostgreSQL (Drizzle) + RLS + test
design/canvas/    ไฟล์หน้าจอ 51 หน้า (.dc.html) + canvas.json (ตำแหน่งและชื่อของแต่ละหน้า)
docs/
  decisions.md      คำตัดสินด้าน UX/UI และธรรมเนียมการวางแผนขององค์กร
  tech-stack.md     Tech Stack ที่ตกลงไว้ และรายการที่มีค่าใช้จ่าย
  review-round-2.md ข้อมูลที่ใช้ใน Review รอบ 2 (ส่วนไหนจริง ส่วนไหนจำลอง)
  spec/             สเปกที่ถอดจาก UI v1.0: Entity, ERD, API, สิทธิ์
```

ไฟล์ใน `design/canvas/` เป็นสำเนาจาก Canvas และต้องใช้ตัวแสดงผลของ Canvas (`support.js`) จึงเปิดตรงในเบราว์เซอร์ไม่ได้ ให้ดูผ่านลิงก์ Canvas ด้านบน

## ขั้นตอนถัดไป

1. ~~ส่ง Review รอบ 2 ให้ทีม~~ · ~~ล็อก UI เป็น v1.0~~
2. ถอดสเปกจากหน้าจอ: ~~รายการ Entity~~ → ~~ERD~~ → ~~API ของแต่ละหน้า~~ → ~~สิทธิ์ของแต่ละ Role~~ (ร่างแรก) · ดู [docs/spec](docs/spec/README.md)
3. ~~Migration แรก + RLS~~ · ดู [packages/db](packages/db/README.md)
4. API ตัวแรก (NestJS) แล้วต่อด้วยหน้าเว็บ ตาม [Tech Stack](docs/tech-stack.md)
