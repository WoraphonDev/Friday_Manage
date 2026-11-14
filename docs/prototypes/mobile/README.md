# Friday Manage — Mobile UI prototypes

ชุดต้นแบบที่ Claude Code ออกแบบและ Zo อนุมัติให้เก็บในโปรเจกต์ ไม่ใช่ UI production และไม่เปลี่ยน desktop / API / database

## เปิดใช้งาน

จากราก repository:

```sh
python3 -m http.server 18765 --bind 127.0.0.1 --directory docs/prototypes/mobile
```

- แบบที่เลือก: http://127.0.0.1:18765/claude-friday-mobile-selected/index.html
- Landing: http://127.0.0.1:18765/claude-friday-mobile-selected/index.html#/pub.landing/default?w=390
- เทียบ A/B/C: http://127.0.0.1:18765/claude-friday-mobile-complete/index.html

ต้องเปิดผ่าน HTTP ไม่ใช่ file:// เพราะใช้ fetch อ่าน inventory.json และต้องเก็บสองโฟลเดอร์ไว้คู่กัน: แบบที่เลือกโหลด engine/data จาก gallery เดิมผ่าน relative path

## ทิศทางที่เลือก

B เป็นฐานของหน้าตาและ navigation, A สำหรับรายการที่ต้องกระชับ, C สำหรับรายละเอียด ฟอร์ม และปุ่มทำงาน โดยใช้ token เดียวกัน รายการเฉพาะดู CHOICES.json และ HANDOFF.md ในโฟลเดอร์ selected

## ขอบเขตและสถานะ

- Gallery เดิม: 189 รายการ × 3 ทิศทาง = 567 พรีวิว
- Unified: 192 รายการ รวมหน้ารายการโปรเจกต์, sheet แก้งาน และ Ops Abuse ที่เพิ่มจาก gallery เดิม
- ใช้ข้อมูลสมมติ ไม่เรียก API และไม่ใช่ business logic ที่นำขึ้นจริงได้
- Host เคยตรวจสร้าง DOM ของ 567 พรีวิวได้โดยไม่มี exception; unified เปิด gallery และอ่าน coverage ได้ 192 รายการ ไม่ใช่หลักฐานว่า flow / pixel / accessibility ผ่านครบ
- หลายหน้าใช้ renderer ร่วมตามชนิดหน้า; loading/empty/error บางส่วนใช้ส่วนกลาง; drag และ chart interaction ยังไม่ครบ
- Ops Abuse เป็น canvas-only concept ไม่มี production route/contract
- ต้องตรวจทุก flow, keyboard/focus, safe-area, mobile overflow และ desktop baseline ก่อนนำไป implement
- งานนี้เก็บเฉพาะไฟล์ static prototype ไม่ใช่งานเปลี่ยนแอป จึงไม่มีการ build/deploy production Docker

อย่า import assets ชุดนี้เข้า apps/web โดยตรง ให้ใช้อ้างอิงสำหรับ implementation PR แยกตาม module
