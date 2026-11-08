# คำตัดสินด้าน UX/UI และธรรมเนียมการวางแผน

## แนวทางหลัก

- **UI ก่อน API:** ต้องให้ UI ผ่าน Review และล็อกก่อน แล้วค่อยออกแบบฐานข้อมูลและ API จากหน้าจอ (เพราะโปรเจกต์ก่อนหน้าทำ API ก่อนแล้ว UI ไม่ผ่าน)
- **เป้าหมายระยะยาว:** เป็น SaaS จึงออกแบบให้รองรับหลายองค์กร (multi-tenant), แพ็กเกจ Free / Team / Enterprise, SSO, การเลือก Data region และ Audit log ตั้งแต่แรก
- **มุมมองภาพรวมออกแบบสำหรับ Lead / PM** ไม่ใช่ผู้บริหาร

## ค่าเริ่มต้นการวางแผน

ค่าในหัวข้อนี้มาจากไฟล์ Excel ตัวอย่างที่ผู้ใช้เขียนขึ้นเอง ไม่ใช่ข้อกำหนดขององค์กร (ผู้ใช้แจ้ง 8 พ.ย. 2569) · ใช้เป็นค่าเริ่มต้นที่เปลี่ยนได้

- ประเมินงานเป็น **Man-Day + Size**: XS = 1 · S = 3 · M = 5 · L = 8 · XL = 12
- Man-Day ของงานที่มี Dev หลายคน = รวมทั้งทีม (แบ่งเท่ากันเมื่อคิด Workload)
- 1 Man-Day = จ.–ศ. 09:30–18:30 ไม่นับวันหยุดตามประกาศ ธปท. · ถ้า Plan Start ตรงวันหยุด ให้นับจากวันทำงานถัดไป
- งานหนึ่งมี BA 1 คนและ Dev ได้หลายคน อ้างอิง Screen ID (SCR-xxx) และ FR / NFR มี Plan Start–End และ Actual Start–End
- **Sprint:** เป็นระบบรอบงานระดับโปรเจกต์ (ค่าเริ่มต้น 2 สัปดาห์) ชื่อ "Sprint" ทั้งไทยและอังกฤษ · ไม่ใช่ช่องในหน้า Task และไม่ใช่ชื่อคอลัมน์ใน Excel นำเข้า / ส่งออก (8 พ.ย. 2569)

## คำตัดสินจาก Review รอบ 1 (5 พ.ย. 2569)

| # | เรื่อง | ข้อสรุป |
|---|---|---|
| 1 | หน่วยประเมินงาน | Man-Day + Size ตามด้านบน |
| 2 | หน้าจอรายละเอียดงาน | Task และ Sub-task เปิดเป็น **Drawer ด้านขวาเหมือนกัน** · Sub-task ซ้อนเป็นชั้นที่ 2 มีแถบงานแม่ด้านซ้ายให้กดย้อนกลับ · บนมือถือเปิดเต็มจอ |
| 3 | Bug อยู่ระดับไหน | ประเภทงานแยกจากระดับในลำดับชั้น · Bug เป็นได้ทั้ง Task และ Sub-task ใต้งานอื่น |
| 4 | ใครเปลี่ยน Due ได้เอง | ค่าเริ่มต้น Member ต้องขออนุมัติ · ปิดได้รายโปรเจกต์ที่ Project Settings › สิทธิ์ของแต่ละ Role |
| 5 | Guest (ลูกค้า) เห็นอะไร | Overview, Timeline และงานที่แชร์ให้เท่านั้น · ไม่เห็นชื่อผู้รับผิดชอบ, Workload, Bug, Settings และ Time log |
| 6 | มือถือ | ทำ Responsive web ก่อน · แอป Native พิจารณาหลังมีลูกค้าจริง |

## หน้า Task v2 (8 พ.ย. 2569 · Canvas B2 / C2 / D2)

| # | เรื่อง | ข้อสรุป |
|---|---|---|
| 1 | ลำดับงาน | **Module → Task → Sub-task** · เลิกใช้กลุ่มงาน (Phase): ไม่แสดงใน Table, Gantt, Timeline, Kanban และหน้า Task · Excel ไม่นำเข้า / ส่งออกคอลัมน์ Sprint / กลุ่มงาน · ข้อมูลเดิมยังเก็บไว้ |
| 2 | หน้าสร้างกับหน้าดู Task | ใช้หน้าตาเดียวกัน: ซ้าย = ชื่อ, สถานะ, คำอธิบาย, Acceptance criteria, Checklist, Sub-task, Dependency (ค้นหารหัสงานได้), Attachments, ผลทดสอบ QA, Development, Activity และคอมเมนต์ · ขวา = ผู้รับผิดชอบ / แผนงาน / กลุ่มงาน |
| 3 | ผู้รับผิดชอบ | Business Analyst, System Analyst (ช่องใหม่), Developer (หลายคน), QA / Reviewer (รวม Tester กับ Reviewer เป็นช่องเดียว), ผู้ติดตาม |
| 4 | แผนงาน | Size, Man-Day, Plan Start–End, Actual Start–End, Progress |
| 5 | กลุ่มงาน (หัวข้อในหน้า Task) | Priority, Module, Requirement, Screen, Label, แชร์งานนี้ให้ Guest · Bug มี Severity / Environment เพิ่ม |
| 6 | Acceptance criteria / Checklist | แยกสองกล่องเสมอ เพิ่มในกล่องไหนเป็นประเภทนั้น · ย้ายไป Done ทั้งที่ Acceptance criteria ยังติ๊กไม่ครบ ต้องยืนยันก่อน |
| 7 | Sub-task | รายละเอียดเหมือน Task (รวมไฟล์แนบและผลทดสอบ QA) · วันที่เกินช่วง Task: เตือน ยืนยัน แล้วขยาย Task ให้ครอบ Sub-task และบันทึกลงประวัติการแก้แผน · เปลี่ยน Task แม่ได้เฉพาะ Task ใน Module เดียวกัน |
| 8 | ผลทดสอบ | ผลทดสอบ QA (QA / Reviewer) แยกจากผล Unit test (Dev แนบเองในส่วน Development พร้อม Coverage) · ผล Unit test แสดงอย่างเดียว ไม่เตือนตอนย้ายงาน |
| 9 | ไฟล์แนบ | แนบได้ทั้งระดับงาน คอมเมนต์ และผลทดสอบ โดยอัปโหลดจากหน้า Task ได้เลย |
| 10 | Status และ Bug | ใช้เหมือนเดิม |
| 11 | ผลตรวจของ QA / Reviewer | เก็บแค่ ผล (ผ่าน / ไม่ผ่าน), ผู้ตรวจ (ค่าเริ่มต้น = QA / Reviewer ของงาน), Environment, บันทึก / ขั้นตอนที่พบปัญหา (บังคับเมื่อไม่ผ่าน) และไฟล์หลักฐาน ทั้ง Task และ Sub-task · จำนวนเคส / Commit / Coverage เป็นของผล Unit test เท่านั้น · API ยังรับค่าเดิม (`blocked`, `passedCount`) จากเครื่องมืออื่นได้ |
| 12 | ไฟล์ Excel นำเข้า / ส่งออก | ชีต **Tasks**: Key, Parent Key, Module, Title, Status, Priority, Business Analyst, System Analyst, Developer, QA / Reviewer, Size, Man-Day, Plan Start/End, Actual Start/End, Requirement, Screen, Label, Description + ชีตคำแนะนำ, ค่าที่ใช้ได้ (รายการเลือกในเซลล์) และ Holidays · จับคู่งานด้วย Key (ว่าง = งานใหม่) · Parent Key = Sub-task (Module ตาม Task แม่) · โหมดอัปเดตไม่แตะคอลัมน์ที่ไม่มีในไฟล์ · ดาวน์โหลด Template เปล่าได้ที่หน้านำเข้า · ไฟล์รูปแบบเดิมที่มีคอลัมน์ No. ยังจับคู่ด้วย No. เหมือนเดิม |
| 13 | Table | มีคอลัมน์ SA (System Analyst) ถัดจาก BA แก้ในตารางได้ |

## การแจ้งเตือนและเวลา

- ช่องทางนอกแอป: **LINE OA + Email + Webhook ทั่วไป** (Discord / Slack / Teams / Telegram ผ่าน Webhook) ไม่ทำ Integration แยกรายเจ้า
- อนุมัติคำขอเลื่อน Due ผ่านปุ่มใน LINE ได้ (ตรวจบัญชีที่ผูก + บันทึก Audit log)
- ไม่ทำ Timesheet เพราะองค์กรมีระบบ HR · Time log ปิดเป็นค่าเริ่มต้นรายโปรเจกต์ · เชื่อมระบบ HR เพื่อดึงวันลา

## SaaS

- ลูกค้ากลุ่มแรก: software house / ทีม Dev ขนาดเล็กถึงกลาง
- ราคาเหมาตามขนาดทีม: Free ≤ 5 คน · Team S ≤ 10 · Team M ≤ 25 · Team L ≤ 50 · Enterprise 50+ · ทุกแพ็กเกจ Team มีฟีเจอร์เท่ากัน · ยังไม่กำหนดราคาจริง
- ชำระด้วยบัตรเครดิต, PromptPay และโอนเงิน พร้อมใบกำกับภาษี e-Tax และรองรับหัก ณ ที่จ่าย 3% (50 ทวิ)
- ทีม Friday เข้าบัญชีลูกค้าได้เฉพาะเมื่อลูกค้าเปิดสิทธิ์ไว้ล่วงหน้า ต้องมี Ticket และบันทึก Audit log
