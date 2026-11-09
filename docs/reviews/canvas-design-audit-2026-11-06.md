# ผลตรวจ UI Design เทียบ Canvas — 6 พฤศจิกายน 2569

พบ **26 รายการที่ต้องแก้ด้าน Design**: P1 (โครงสร้าง/การใช้งานหลัก) 16 รายการ และ P2 (รายละเอียดองค์ประกอบ) 10 รายการ ระดับนี้เป็นลำดับแก้ด้าน Design ไม่ใช่ระดับช่องโหว่ ระบบยังไม่ผ่านการยืนยันว่าเหมือน Canvas

เปิด [รายงานภาพเทียบแบบเลือกหน้า/ขนาด/ซ้อนภาพ](design-audit-2026-11-06/index.html) · [Overview ภาพคู่](design-audit-2026-11-06/compare-Main-1440.jpg) · [Mobile Overview](design-audit-2026-11-06/compare-MobileOverview-390.jpg) · [รายการทั้งหมด JSON](design-audit-2026-11-06/findings.json)

## วิธีตรวจและความครอบคลุม

- Source commit `46719fabcc1620d1166ec4604cfdeac862f0e058`; ใช้ git archive แยก ไม่แตะไฟล์ที่ Claude กำลังแก้
- Chromium 153.0.8010.12 ผ่าน Playwright ตามที่ผู้ใช้ระบุให้ใช้; headless/profile แยกจาก Chrome จริง; DPR 1, timezone Asia/Bangkok, locale th-TH
- Canvas 51 บอร์ด → ภาพอ้างอิง 96 ภาพ; จับคู่ UI/สถานะ 50 บอร์ด → ภาพ 94 ภาพ ทั้ง 1440 และ390 px (บอร์ด Mobile เฉพาะที่390) โดย ReviewGuide ไม่มี UI คู่ตรง; States เป็น pattern board ไม่ใช้หน้า /dev/ui ที่ production ปิดไว้ตัดสินว่าผลิตภัณฑ์ขาดหน้า
- เพิ่มภาพ UI จริง 6 สถานะ ×2 ขนาด (404/403/Error/Loading/Empty/Success) สำหรับ M1
- อ่านภาพรวมทุกบอร์ดผ่าน contact sheets และตรวจขนาด/DOM/CSS เฉพาะจุดที่ยืนยันความต่าง ไม่ใช้จำนวน test ที่ผ่านเป็นหลักฐานว่า Design เหมือน
- ใช้ Workspace `visual-audit` ใน DB `friday_codex_audit2_20261106` ที่แยกจาก Claude; migration ถึง0012, ข้อมูลสมมติ 24 Task +1 Sub-task +1 Bug, 4สมาชิก, Phase/Sprint, แจ้งเตือน, ไฟล์/preview, invitation และกฎ Automation
- ลำดับ state จับคู่ให้ตรง เช่น Invite เปิด, Workflow active, Import step3, Kanban In progress, Inbox mobile เป็น list; ถ้าไม่ตรง state ไม่นับเป็น Design defect
- ทุกภาพโหลดฟอนต์ IBM Plex Sans Thai สำเร็จ ไม่มี JS page error หรือ document overflow แนวนอนของ UI ทั้ง94ภาพ ทั้งนี้ไม่ล้นจอไม่ได้แปลว่าเหมือนแบบ
- Snapshot Canvas ใน repo อ้าง `support.js` ที่ไม่มีในrepo จึงใช้ render shim ชั่วคราวของ Canvas (DCLogic/sc-for/sc-if/ข้อความผูกค่า) ในสำเนาเท่านั้น ไม่แก้ HTML/CSS ต้นฉบับ; ฟอนต์ Google ในสำเนาเปลี่ยนเป็นไฟล์ตระกูลเดียวกันจาก @fontsource ในเครื่องเพื่อให้โหลดแน่นอน; template เหลือ0และไม่มี render error ทั้ง96ภาพ จึงเป็นการ reconstruct reference ไม่ใช่ screenshot export จากแอป Canvas โดยตรง
- ตรวจสถานะหลักที่ระบุของทุกบอร์ด ไม่ได้ไล่ทุกแท็บ/ตัวเลือก/hover/ทุกบทบาทในแต่ละหน้า; ผลใกล้เคียงจึงไม่ใช่การรับรองทุก interaction
- หลักฐานแหล่งภาพและ SHA-256 อยู่ใน [capture-provenance.json](design-audit-2026-11-06/capture-provenance.json); ผลตรวจตัวรายงานอยู่ใน [report-qa.json](design-audit-2026-11-06/report-qa.json)
- ไม่คำนวณเปอร์เซ็นต์ pixel similarity เพราะจำนวนงาน/ชื่อ/วัน/ราคา/สถานะในข้อมูลจริงกับตัวอย่างไม่ตรงกัน โดยเฉพาะหน้าที่เป็น demo หลายสถานะในบอร์ดเดียว

## สิ่งที่ตรงแล้ว

ฟอนต์หลัก, body text desktop14px, h1 desktop22px, สีพื้นหลัง #F6F7F9, สีหลัก #1D4ED8, border/card radius และ top bar desktop56px ตรงเป็นฐาน ความต่างหลักอยู่ที่ composition, navigation, grouping และ variants ของหน้าจอ จึงไม่ควรเริ่มแก้ด้วยการเปลี่ยน font/theme ทั้งระบบ

## หลักฐานตัวเลขสำคัญ

| จุด | Canvas | UI จริง | ผล |
|---|---|---|---|
| Sidebar Main/Table ที่1440 | ≈220.6px | 240px | content เริ่มขวาเพิ่ม≈19.4px |
| Project header Main/Table | 125px | 152px | เนื้อหาต่ำลง27px |
| Task create drawer | x800,w640,ใต้header | x680,w760,y0 | กรอบและขนาดผิดvariant |
| Task detail drawer | x580,w860,y159 | x680,w760,y0 | แคบลง100px และทับheader |
| Bug create | modal x290,w860,y40 | drawer x680,w760,y0 | ใช้คนละชนิดองค์ประกอบ |
| Command palette | y128,w680 | top72,w680 | สูงกว่าแบบ56px |
| Mobile Overview headerรวม | 127px | 56+168.5=224.5px | กินพื้นที่เพิ่ม97.5px |
| Bottom nav หน้าหลักมือถือ | 5รายการ | 4รายการ | ขาดProfile/ลำดับต่าง |
| Import CTA ที่390×844 | ต้องกดได้ | y775,h40; navเริ่ม788 | ถูกบัง27px และpointerไปInbox |

ดู [reference-measurements.json](design-audit-2026-11-06/reference-measurements.json), [actual-manifest.json](design-audit-2026-11-06/actual-manifest.json), [หลักฐานปุ่มถูกบัง](design-audit-2026-11-06/import-mobile-overlap.json) และ [ภาพปุ่มที่ถูกบัง](design-audit-2026-11-06/actual/ImportExcel-step2-overlap-390.png)

## รายการแก้ให้ Claude

| ID | ลำดับ | เรื่อง | Lane | สถานะ |
|---|---|---|---|---|
| VD01 | P2 | Sidebar desktop กว้างและจัดเมนูต่างจากแบบ | W00 | รอแก้ |
| VD02 | P1 | Project header สูญเสียองค์ประกอบและสูงกว่า Canvas | W00 | รอแก้ |
| VD03 | P1 | หน้าบริบทเฉพาะยังถูกครอบด้วย Workspace/Project shell เต็มชุด | W00 + W15/W18/W19 | รอแก้ |
| VD04 | P1 | Mobile app bar และ bottom navigation ไม่ตรง M2–M7 | W00 | รอแก้ |
| VD05 | P1 | Overview summary เปลี่ยนจากการ์ดรวมเป็น 5 การ์ด | W05 | รอแก้ |
| VD06 | P1 | Overview KPI/list/ข้อมูลโปรเจกต์จัดใหม่คนละโครง | W05 | รอแก้ |
| VD07 | P1 | Table toolbar ขาดชุดควบคุมในแบบ | W05 | รอแก้ |
| VD08 | P1 | Table ใช้ native select ทุกแถวและสลับชุดคอลัมน์ | W05 | รอแก้ |
| VD09 | P2 | Table bulk bar และ action ของแถวอยู่ผิดตำแหน่ง | W05 | รอแก้ |
| VD10 | P1 | Task create drawer ใช้กรอบเดียวกับ detail และ form arrangement ต่าง | W02 | รอแก้ |
| VD11 | P1 | สร้าง Bug/Story/Spike ใช้ drawer แทน centered modal | W02 | รอแก้ |
| VD12 | P1 | Task/Bug detail เปลี่ยน information architecture | W02 | รอแก้ |
| VD13 | P2 | Sub-task มี parent navigation ซ้ำและ rail/พื้นที่เนื้อหาต่าง | W02 | รอแก้ |
| VD14 | P1 | Mobile Home ยังเป็น desktop ที่ยุบคอลัมน์ | W03 | รอแก้ |
| VD15 | P1 | Mobile Overview ไม่ใช้ summary compact ของ M6 | W05 + W00 | รอแก้ |
| VD16 | P1 | Mobile My Tasks/Inbox ไม่ใช้โครง toolbar และ list ของ M2/M3 | W03/W04 + W00 | รอแก้ |
| VD17 | P2 | Mobile Kanban toolbar/card actions ต่างจาก M7 | W06 + W00 | รอแก้ |
| VD18 | P1 | Mobile Sub-task properties ดันเนื้อหาหลักพ้นจอ | W02 | รอแก้ |
| VD19 | P1 | Import บนมือถือ: เมนูล่างบังปุ่มถัดไปจนแตะไม่ได้ | W14 + W00 | รอแก้ |
| VD20 | P2 | Profile notification connections ขาดการ์ดกลุ่มทีม | W17 | รอแก้ |
| VD21 | P2 | Invite dialog ใช้ controls/สัดส่วนต่างจาก H | W10 | รอแก้ |
| VD22 | P2 | Due request dialog ขาดตัวเพิ่มวันและจัดส่วนผลกระทบต่าง | W02 | รอแก้ |
| VD23 | P1 | Delete confirmation ไม่มีตัวเลือกจัดการ Sub-task ตาม P3 | W02/A03 | รอแก้ |
| VD24 | P2 | Notification toast ไม่รองรับ action ใน Canvas K4 | W04/W00 | รอแก้ |
| VD25 | P2 | Command palette อยู่สูงกว่าแบบ 56 px | W16 | รอแก้ |
| VD26 | P2 | New Project template choices จัด grid ต่างจาก A | W13 | รอแก้ |

## รายละเอียดและเกณฑ์ปิดงาน

### VD01 · Sidebar desktop กว้างและจัดเมนูต่างจากแบบ

**Canvas:** Canvas Main/Table ที่ 1440: Sidebar ≈220.6 px; Admin Console อยู่ด้านล่าง

**UI จริง:** UI ใช้ 240 px; เพิ่มกลุ่ม ADMIN CONSOLE และ Billing ในช่วงกลาง; ชื่อโปรเจกต์ตัดหนึ่งบรรทัดแทนการ wrap

**แก้เสร็จเมื่อ:** เทียบตำแหน่งเส้นขอบ Sidebar และการ wrap ชื่อโปรเจกต์กับภาพที่ 1440; คงสิทธิ์และเมนูที่จำเป็นโดยจัดตำแหน่งตามแบบ

ไฟล์: `apps/web/src/styles/tokens.css`, `apps/web/src/styles/globals.css`, `apps/web/src/components/shell/workspace-shell.tsx` · บอร์ด: Main, Table, Home, MyTasks, Inbox, Profile

### VD02 · Project header สูญเสียองค์ประกอบและสูงกว่า Canvas

**Canvas:** Main/Table: header สูง 125 px; ชื่อ+สถานะ+Health+วันที่ในแถวเดียว มี Avatar stack, Invite, เมนู ⋯

**UI จริง:** header สูง 152 px; metadata แยกลงแถว; ไม่มี Avatar stack/Invite/เมนูโปรเจกต์/Health ใน header; เนื้อหาเริ่มต่ำลง 27 px

**แก้เสร็จเมื่อ:** คืนองค์ประกอบครบและวัดความสูง/แนว baseline ตาม Canvas โดยข้อมูลชื่อยาวยังไม่ดัน layout

ไฟล์: `apps/web/src/components/shell/project-shell.tsx`, `apps/web/src/styles/globals.css` · บอร์ด: Main, Table, Kanban, Timeline, Gantt, Calendar, Members, Files, Backlog, ProjectSettings

### VD03 · หน้าบริบทเฉพาะยังถูกครอบด้วย Workspace/Project shell เต็มชุด

**Canvas:** N1/O1/O2/N2/P2/R2 ใช้ header/navigation เฉพาะบริบทตามแต่ละบอร์ด

**UI จริง:** Admin/Reports มีเมนู Workspace ซ้อนกับเมนูของหน้า; Lead/Reports/Automation มี project header เต็ม; Checkout มี sidebar/search/bell ที่แบบ R2 ไม่มี

**แก้เสร็จเมื่อ:** กำหนด shell ตาม route/context ไม่ลบเมนูร่วมทุกหน้าแบบเหมารวม; พื้นที่เนื้อหาและจุดเริ่ม x/y ตรงบอร์ดของหน้านั้น

ไฟล์: `apps/web/src/components/shell/workspace-shell.tsx`, `apps/web/src/components/shell/project-shell.tsx`, `apps/web/app/work/[ws]/admin/_components/admin-console.tsx` · บอร์ด: AdminConsole, LeadDashboard, Reports, NotifyTemplates, Automation, Checkout

### VD04 · Mobile app bar และ bottom navigation ไม่ตรง M2–M7

**Canvas:** Mobile Canvas ใช้ app bar สีขาวตามบริบท; bottom bar มี Home/My Tasks/Projects/Inbox/Profile 5 รายการ

**UI จริง:** UI คง top bar มืด 56 px และ bottom bar มี 4 รายการ Home/My Tasks/Inbox/Projects; ไม่มี Profile และลำดับต่าง

**แก้เสร็จเมื่อ:** เทียบทั้ง 5 บอร์ดที่ 390×844; header/back/menu และ 5 จุดนำทางตรงแบบ พร้อม active state ตามหน้า

ไฟล์: `apps/web/src/components/shell/workspace-shell.tsx`, `apps/web/src/components/shell/project-shell.tsx`, `apps/web/src/styles/globals.css` · บอร์ด: MobileHome, MobileMyTasks, MobileInbox, MobileOverview, MobileKanban

### VD05 · Overview summary เปลี่ยนจากการ์ดรวมเป็น 5 การ์ด

**Canvas:** การ์ดรวมมี donut progress, เวลา/งานเสร็จ, Go-live, Milestone และ Health ภายในกรอบเดียว

**UI จริง:** ใช้ .top grid 5 cards; ไม่มี donut; Health อยู่อีกกรอบ แยกการอ่านออกจากกัน

**แก้เสร็จเมื่อ:** คืนโครง summary card desktop ตาม Main; mobile ใช้องค์ประกอบ M6 โดยไม่ stack 5 card desktop

ไฟล์: `apps/web/app/work/[ws]/p/[key]/table/_components/overview.tsx`, `apps/web/app/work/[ws]/p/[key]/table/_components/ot.module.css` · บอร์ด: Main, MobileOverview

### VD06 · Overview KPI/list/ข้อมูลโปรเจกต์จัดใหม่คนละโครง

**Canvas:** 4 KPI cards แยกกรอบพร้อมจุดสี/เส้นเลือก; รายการมี checkbox และบรรทัด Module/กลุ่มงาน; ข้อมูลโปรเจกต์มีเป้าหมาย ขอบเขต เอกสาร อยู่ใต้กราฟด้านซ้าย

**UI จริง:** KPI เชื่อมเป็น tab strip ใน list card; รายการลดเป็นบรรทัดเดียว; project info ย้ายไปคอลัมน์ขวาและเหลือ Lead/จำนวนสมาชิก

**แก้เสร็จเมื่อ:** คืนลำดับชั้นและตำแหน่ง section; อย่าใช้จำนวนรายการตัวอย่างเป็นเงื่อนไขจัด layout

ไฟล์: `apps/web/app/work/[ws]/p/[key]/table/_components/overview.tsx`, `apps/web/app/work/[ws]/p/[key]/table/_components/ot.module.css` · บอร์ด: Main

### VD07 · Table toolbar ขาดชุดควบคุมในแบบ

**Canvas:** มี Views งานของฉัน/Overdue/Sprint/Backlog; Filter, Group by, BA, Dev, Size, Sort, Columns, Import/Export, +Module/+Task

**UI จริง:** ใช้ search + select Status/Dev/Priority/ระดับ กับสอง toggle; ชุด Group by/BA/Size/Sort/Columns และ action หลายตัวไม่อยู่ใน toolbar ตามแบบ

**แก้เสร็จเมื่อ:** ทำ inventory คอนโทรลตาม Table.dc.html ให้ครบ จัดแถวและระยะห่างตรงที่ 1440 พร้อมทางเข้าที่ใช้ได้บน 390

ไฟล์: `apps/web/app/work/[ws]/p/[key]/table/_components/table-view.tsx` · บอร์ด: Table

### VD08 · Table ใช้ native select ทุกแถวและสลับชุดคอลัมน์

**Canvas:** สถานะเป็น pill/ตัวบ่งชี้สีในแถว; มี FR/Screen; header/column widths และแถวกลุ่มตามแบบ

**UI จริง:** Status/Priority เป็น select box ค้างทุกแถว, เพิ่ม Priority column แต่ไม่มี FR/Screen แบบ; row density และสี group ต่าง

**แก้เสร็จเมื่อ:** แสดงค่าปกติให้เหมือน pill/cell ใน Canvas และเปิด editor เมื่อแก้; คืนคอลัมน์/width และ group hierarchy โดยยังคง edit ได้

ไฟล์: `apps/web/app/work/[ws]/p/[key]/table/_components/table-view.tsx`, `apps/web/app/work/[ws]/p/[key]/table/_components/ot.module.css` · บอร์ด: Table

### VD09 · Table bulk bar และ action ของแถวอยู่ผิดตำแหน่ง

**Canvas:** เลือกแถวแล้ว bulk bar อยู่เหนือหัวตาราง; แถว Module/Phase มี action เพิ่มงานและท้ายกลุ่ม

**UI จริง:** bulk bar เป็นแถบ sticky ล่าง; action inline และแถวเพิ่ม Task/สรุปท้ายกลุ่มไม่ครบตามแบบ

**แก้เสร็จเมื่อ:** เลือก 2 แถวแล้วเทียบตำแหน่ง bulk bar และ action ต่อ Module/Phase; ไม่บังแถวล่างบนมือถือ

ไฟล์: `apps/web/app/work/[ws]/p/[key]/table/_components/table-view.tsx`, `apps/web/app/work/[ws]/p/[key]/table/_components/ot.module.css` · บอร์ด: Table

### VD10 · Task create drawer ใช้กรอบเดียวกับ detail และ form arrangement ต่าง

**Canvas:** TaskCreate reference: drawer x=800,w=640 ที่ 1440 เริ่มใต้ header; กลุ่ม field/estimate/description/subtasks ตามแบบ B

**UI จริง:** UI x=680,w=760 เริ่ม y=0; ทำเป็นฟอร์มทั่วไปยาวพร้อม fields เรียงใหม่

**แก้เสร็จเมื่อ:** แยก variant สร้าง Task ออกจาก detail/Bug; เทียบ width, top offset, field grouping และ footer ของ B โดยไม่ทำให้ validation หาย

ไฟล์: `apps/web/src/features/issue-drawer/create-issue.tsx`, `apps/web/src/features/issue-drawer/issue-drawer.module.css`, `apps/web/src/components/ui/overlays.tsx` · บอร์ด: TaskCreate

### VD11 · สร้าง Bug/Story/Spike ใช้ drawer แทน centered modal

**Canvas:** K1 เป็น modal กลางจอ x=290,w=860,y=40 ที่ 1440 พร้อมการ์ดเลือกประเภทและส่วนรายละเอียดเฉพาะประเภท

**UI จริง:** ทุกประเภทเปิด right drawer x=680,w=760,y=0; type selector เป็น segmented แถวเล็ก

**แก้เสร็จเมื่อ:** ใช้ modal variant ตาม K1 และจัด severity/environment/steps/expected/actual ตามแบบ; ไม่ใช้ drawer ทั่วไปแทน

ไฟล์: `apps/web/src/features/issue-drawer/IssueDrawer.tsx`, `apps/web/src/features/issue-drawer/create-issue.tsx` · บอร์ด: IssueCreate

### VD12 · Task/Bug detail เปลี่ยน information architecture

**Canvas:** Task detail มี drawer 860 px; Description/Checklist/Subtasks/Dependency/Development/Attachments/Comments ต่อเนื่อง; properties column กระชับ; Bug มี steps/expected/actual และ Verify/Reopen เด่น

**UI จริง:** drawer 760 px จากบนสุด; ใช้ 4 tabs แทน section ต่อเนื่อง; หน้าแรกของ Task เหลือ description/subtasks/watchers และไม่อยู่ใน composition เดิมของ Development/attachments/QA; Bug มี steps/expected/actual แต่ label ซ้ำและจัดแนวตั้งแทนคู่คอลัมน์

**แก้เสร็จเมื่อ:** คืนโครง C/K2 และรายละเอียดที่สเปก API รองรับ; ใช้ไฟล์แนบที่ seed ไว้ยืนยันว่าแสดงได้จริง ไม่ตรวจเฉพาะกรณีไม่มีข้อมูล

ไฟล์: `apps/web/src/features/issue-drawer/issue-panel.tsx`, `apps/web/src/features/issue-drawer/issue-parts.tsx`, `apps/web/src/features/issue-drawer/issue-drawer.module.css` · บอร์ด: TaskDetail, BugDetail

### VD13 · Sub-task มี parent navigation ซ้ำและ rail/พื้นที่เนื้อหาต่าง

**Canvas:** parent breadcrumb/rail เดียวในตำแหน่งที่กำหนด พร้อมแยก parent กับ child ชัดเจน

**UI จริง:** มี parentLabel ของ Drawer และ parent/sibling navigation ใน panel ซ้ำกัน เพิ่มความสูงก่อนชื่องาน; สัดส่วน rail ต่างจาก D/M4

**แก้เสร็จเมื่อ:** เทียบทั้งการเปิดจาก Task แม่และ deep link โดยคงแถบ parent เพียงชุดที่เหมาะกับ viewport

ไฟล์: `apps/web/src/features/issue-drawer/IssueDrawer.tsx`, `apps/web/src/features/issue-drawer/issue-panel.tsx`, `apps/web/src/components/ui/overlays.tsx` · บอร์ด: SubtaskModal, MobileSubtask

### VD14 · Mobile Home ยังเป็น desktop ที่ยุบคอลัมน์

**Canvas:** M5 มีหัวต้อนรับ/ค้นหา, KPI 3 ช่องแถวเดียว, รออนุมัติ/วันนี้ก่อนโปรเจกต์ ใน 844 px

**UI จริง:** เพิ่ม top bar และ +New project; KPI desktop 5 ช่องกินหลายแถว ทำให้สิ่งที่ต้องทำเลื่อนลงมาก

**แก้เสร็จเมื่อ:** วาง hierarchy ของ M5 โดยเฉพาะ; หน้าจอแรกต้องเห็นรายการที่รอการตัดสินใจเมื่อมีข้อมูล

ไฟล์: `apps/web/app/work/[ws]/my-tasks/_components/home-page.tsx` · บอร์ด: MobileHome

### VD15 · Mobile Overview ไม่ใช้ summary compact ของ M6

**Canvas:** M6 header รวม tabs สูง 127 px และ summary compact ที่มี progress/KPI 3 ช่อง ก่อน Milestone/ความเสี่ยง

**UI จริง:** UI topbar56 + project header168.5 =224.5 px; summary 5 cards เรียงลงมา ใช้พื้นที่ก่อน Milestone สูงมาก

**แก้เสร็จเมื่อ:** header รวมใกล้ 127 px ตามแบบ และ summary/card order ของ M6; ไม่ถือว่าการไม่ล้นแนวนอนคือผ่าน Design

ไฟล์: `apps/web/app/work/[ws]/p/[key]/table/_components/overview.tsx`, `apps/web/src/components/shell/project-shell.tsx` · บอร์ด: MobileOverview

### VD16 · Mobile My Tasks/Inbox ไม่ใช้โครง toolbar และ list ของ M2/M3

**Canvas:** My Tasks มี avatar filters/search/filter icon และรายการกะทัดรัด; Inbox มี title/read-all inline และ 3 filter chips

**UI จริง:** ยังมีแถบ header กลางและชุด desktop filter/action button; Inbox filter หลายชุดและใช้พื้นที่แนวตั้งมากกว่า

**แก้เสร็จเมื่อ:** เทียบ 390×844 ด้วย list state เดียวกัน; ให้ controls/spacing และจำนวนรายการที่มองเห็นใกล้แบบ ไม่ใช้จำนวนข้อมูลมาชดเชย

ไฟล์: `apps/web/app/work/[ws]/my-tasks/_components/my-tasks-page.tsx`, `apps/web/app/work/[ws]/inbox/_components/inbox-page.tsx` · บอร์ด: MobileMyTasks, MobileInbox

### VD17 · Mobile Kanban toolbar/card actions ต่างจาก M7

**Canvas:** M7 app bar ขาว, status chips กับ WIP notice, card กระชับและปุ่มย้ายไป

**UI จริง:** มี dark globalbar/project header/filters หลายแถว; card แสดงปุ่มลูกศร/เรียงหลายปุ่มเพิ่ม

**แก้เสร็จเมื่อ:** เทียบคอลัมน์ In progress ที่เลือกตรงกัน; ลด action ให้ตรง M7 และคงการย้ายงานที่มือถือใช้ได้

ไฟล์: `apps/web/app/work/[ws]/p/[key]/board/_components/kanban-board.tsx`, `apps/web/app/work/[ws]/p/[key]/board/_components/kanban.module.css` · บอร์ด: MobileKanban

### VD18 · Mobile Sub-task properties ดันเนื้อหาหลักพ้นจอ

**Canvas:** M4 แสดง title/status/ปุ่มเสร็จ, compact assignee/due/priority/progress, tabs และ checklist พร้อม comment composer ล่าง

**UI จริง:** มี header/breadcrumb ซ้ำ แล้วแสดง properties เป็นฟอร์มเต็มก่อน tabs; checklist และ composer ไม่อยู่ใน composition แรก

**แก้เสร็จเมื่อ:** จัด layout mobile detail โดยเฉพาะ ไม่ใช้ properties panel desktop มาเรียงก่อน body; เทียบ 390×844

ไฟล์: `apps/web/src/features/issue-drawer/issue-panel.tsx`, `apps/web/src/features/issue-drawer/issue-drawer.module.css` · บอร์ด: MobileSubtask

### VD19 · Import บนมือถือ: เมนูล่างบังปุ่มถัดไปจนแตะไม่ได้

**Canvas:** CTA ต้องอยู่เหนือ fixed navigation และแตะได้ที่ 390×844

**UI จริง:** ปุ่ม y=775,h=40; bottom nav y=788,h=56; nav บัง 27 px และรับ pointer แทนปุ่ม; Playwright click ล้มเหลวจริง

**แก้เสร็จเมื่อ:** เพิ่ม safe-area/scroll padding/sticky footer ให้ปุ่มทั้งหมดพ้น bottom nav; ตรวจ pointer click ได้โดยไม่ force/keyboard workaround

ไฟล์: `apps/web/app/work/[ws]/import/_components/import.module.css`, `apps/web/src/styles/globals.css` · บอร์ด: ImportExcel

### VD20 · Profile notification connections ขาดการ์ดกลุ่มทีม

**Canvas:** I มี In-app, Email, LINE ส่วนตัว และ dashed card กลุ่มทีม LINE/Webhook ลิงก์ไป Project Settings

**UI จริง:** UI แสดง 3 personal connection cards ไม่มีตัวอธิบาย/ทางเข้ากลุ่มทีมตามแบบ

**แก้เสร็จเมื่อ:** คืนการ์ดกลุ่มทีมและอธิบายว่าตั้งโดย PM ไม่ใช่ personal channel; matrix/connection spacing ตรง I

ไฟล์: `apps/web/app/work/[ws]/profile/_components/notify-tab.tsx` · บอร์ด: Profile

### VD21 · Invite dialog ใช้ controls/สัดส่วนต่างจาก H

**Canvas:** Invite modal ตาม H มี role cards และข้อมูลเชิญ/โปรเจกต์/ตัวเลือกเสริมเรียงตามแบบ

**UI จริง:** เปิด modal ได้ แต่ใช้ select/field layout ทั่วไปและกรอบ Dialog ร่วม ทำให้ตำแหน่ง/ความกว้างไม่ตรง

**แก้เสร็จเมื่อ:** เทียบสถานะ Invite เปิดแล้วทั้งสองขนาด พร้อม email หลายรายการและ role/permission ที่เหมือนกัน

ไฟล์: `apps/web/app/work/[ws]/members/_components/invite-dialog.tsx` · บอร์ด: WorkspaceMembers

### VD22 · Due request dialog ขาดตัวเพิ่มวันและจัดส่วนผลกระทบต่าง

**Canvas:** K3 วางเพิ่มกี่วันทำการกับ Due ใหม่ร่วมกัน พร้อม reason และ impact/approvers ในลำดับกะทัดรัด

**UI จริง:** มี date input เต็มแถวอย่างเดียว และ section ผลกระทบเรียงยาว; ไม่มีตัวเพิ่มจำนวนวันในแบบ

**แก้เสร็จเมื่อ:** คืน control จำนวนวันทำการที่คำนวณกับ WorkCalendar และ layout K3 ไม่คำนวณเป็นวันปฏิทินเอง

ไฟล์: `apps/web/src/features/issue-drawer/due-request.tsx` · บอร์ด: DueRequest

### VD23 · Delete confirmation ไม่มีตัวเลือกจัดการ Sub-task ตาม P3

**Canvas:** P3 มีสรุปผลกระทบและตัวเลือกจัดการงานลูก ก่อนยืนยันลบ

**UI จริง:** UI แจ้งจำนวนงานแล้วมี cancel/delete เท่านั้น ไม่มีตัวเลือกในแบบ

**แก้เสร็จเมื่อ:** ยืนยัน product/API semantics ก่อนเพิ่มตัวเลือก; เมื่อเลือกวิธีใด ผลจริงต้องตรงข้อความและ Undo ครบตามวิธีนั้น

ไฟล์: `apps/web/src/features/issue-drawer/issue-panel.tsx` · บอร์ด: ConfirmDialogs

### VD24 · Notification toast ไม่รองรับ action ใน Canvas K4

**Canvas:** K4 toast มี context งานและปุ่มเช่นดูงาน/อนุมัติ/ปฏิเสธ/ปิดตามเหตุการณ์

**UI จริง:** Bell ส่งแค่ข้อความจำนวน unread; ToastOptions รองรับ message/undo/duration จึงไม่มี notification actions

**แก้เสร็จเมื่อ:** เพิ่ม variant/action ตามสิทธิ์ของ event; คง generic undo toast และไม่แสดงปุ่มอนุมัติแก่ผู้ไม่มีสิทธิ์

ไฟล์: `apps/web/src/features/bell/Bell.tsx`, `apps/web/src/components/ui/toast.tsx` · บอร์ด: Bell

### VD25 · Command palette อยู่สูงกว่าแบบ 56 px

**Canvas:** P1 palette x=380,w=680,y=128 ที่ 1440

**UI จริง:** UI กำหนด top:72px; ความกว้าง680ถูกแล้วแต่ตำแหน่งและกลุ่ม hint/footer ต่าง

**แก้เสร็จเมื่อ:** คืน top offset และ spacing ของ header/result/footer ตาม P1 โดย mobile ยังเปิดพอดี viewport

ไฟล์: `apps/web/src/features/command-palette/palette.module.css` · บอร์ด: Search

### VD26 · New Project template choices จัด grid ต่างจาก A

**Canvas:** A วาง Scrum/Kanban/Waterfall 3 ตัวเลือกในแถวและ Blank แถวถัดไป

**UI จริง:** UI วาง 4 ตัวเลือกเป็น 2×2 ทำให้ความสูงและแนวปุ่มถัดไปเปลี่ยน

**แก้เสร็จเมื่อ:** จัด template grid/summary/stepper ตาม A ที่1440 และ responsive ที่390; ใช้สถานะกรอกข้อมูลเดียวกันก่อนเทียบ

ไฟล์: `apps/web/app/work/[ws]/new-project/_components` · บอร์ด: NewProject

## ตารางความครอบคลุมรายบอร์ด

| Canvas | UI/สถานะที่เทียบ | จุดแก้ | หมายเหตุ |
|---|---|---|---|
| 0 · เริ่มที่นี่ — คู่มือ Review | บอร์ดแนวทาง/องค์ประกอบ | ใกล้เคียง/ดูหมายเหตุ | คู่มือ Review ไม่ใช่หน้าผลิตภัณฑ์ จึงเก็บเฉพาะ Canvas |
| 1 · Overview | `/w/visual-audit/p/DP` | VD01, VD02, VD05, VD06 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| 2 · Table (Module › Task › Sub-task) | `/w/visual-audit/p/DP/table` | VD01, VD02, VD07, VD08, VD09 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| 3 · Kanban (drag & drop) | `/w/visual-audit/p/DP/board` | VD02, VD01 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| 4 · Timeline (Module › Task › Sub-task) | `/w/visual-audit/p/DP/timeline` | VD02, VD01 | มี Module/Phase/Task และ timeline; ความยาว bar ตามข้อมูลไม่ใช่ Design defect; ต้องปรับ header ร่วมและ toolbar ตามแบบ |
| 5 · Gantt | `/w/visual-audit/p/DP/gantt` | VD02, VD01 | มี timeline/baseline/แถบเวลา; อย่าตัดสินเส้น dependency หรือ critical path จาก fixture ที่ไม่มีความสัมพันธ์ครบ; header และตำแหน่งเครื่องมือดูภาพเทียบ |
| 6 · Calendar | `/w/visual-audit/p/DP/calendar` | VD02, VD01 | กริดเดือน/agenda/unscheduled มีแล้ว; จำนวนและวันที่ในภาพเป็นข้อมูลสมมติต่างกัน; header ร่วมยังคลาดจากแบบ |
| 7 · Members + Workload | `/w/visual-audit/p/DP/members` | VD02, VD01 | มี workload, KPI และรายชื่อสมาชิก; จำนวนคนและการใช้ capacity ต่างตาม fixture; header ร่วมยังต่าง |
| 8 · Files (Attachments) | `/w/visual-audit/p/DP/files` | VD02, VD01 | ใช้ข้อมูลไฟล์/ลิงก์และเปิด PDF preview แล้วเพื่อไม่เทียบ empty state กับรายการมีข้อมูล; header ร่วมยังต่าง |
| A · + New Project (Wizard 5 ขั้น) | `/w/visual-audit/new-project` | VD26, VD01 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| B · สร้าง Task / Sub-task | `/w/visual-audit/p/DP?new=1` | VD10, VD01, VD02 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| C · Task Detail (Drawer ด้านขวา) | `/w/visual-audit/p/DP?issue=DP-1` | VD12, VD01, VD02 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| D · Sub-task Detail (Drawer ซ้อนบน Task) | `/w/visual-audit/p/DP?issue=DP-25` | VD13, VD01, VD02 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| E · Home | `/w/visual-audit` | VD01 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| F · My Tasks | `/w/visual-audit/my-tasks` | VD01 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| G · Inbox (Notifications) | `/w/visual-audit/inbox?n=01a1b109-613b-797c-b41e-03ccf0ef124c` | VD01 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| H · Workspace Members + Invite | `/w/visual-audit/members` | VD21, VD01 | เปิด Invite dialog แล้วตาม default ของ Canvas H |
| I · User Profile + Notification settings | `/w/visual-audit/profile` | VD01, VD20 | เทียบแท็บการแจ้งเตือนซึ่งเป็น default เดียวกับ Canvas; รูปแบบ connection cards ยังขาดกลุ่มทีม |
| J1 · Login (+ 2FA) | `/login` | ใกล้เคียง/ดูหมายเหตุ | กรอกอีเมล/รหัสผ่านแต่ไม่ส่ง; โครง split pane และ theme ใกล้เคียง |
| J2 · Sign up + ยืนยันอีเมล | `/signup` | ใกล้เคียง/ดูหมายเหตุ | กรอกข้อมูลจำลองเพื่อเห็น password strength; ไม่ส่งสมัครจาก browser; โครงหลักใกล้เคียง |
| J3 · ลืมรหัสผ่าน (3 ขั้น) | `/forgot-password` | ใกล้เคียง/ดูหมายเหตุ | กรอกอีเมลให้ CTA อยู่สถานะเดียวกัน; ไม่ส่งอีเมลจริง; โครงหลักใกล้เคียง |
| J4 · รับคำเชิญ | `/join/<test-token>` | ใกล้เคียง/ดูหมายเหตุ | ใช้คำเชิญสมมติจริง; ชื่อ/อีเมลและสถานะ checkbox ต่างตามข้อมูล ไม่ใช่ความผิดของ CSS |
| J5 · Onboarding (สร้าง Workspace) | `/onboarding` | ใกล้เคียง/ดูหมายเหตุ | ใช้บัญชีสมมติที่ไม่มี Workspace; กรอกชื่อแต่ไม่สร้าง; โครง wizard ใกล้เคียง |
| K1 · สร้างงานตามประเภท (Story / Task / Bug / Spike) | `/w/visual-audit/p/DP?new=1&type=bug` | VD11, VD01, VD02 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| K2 · Bug Detail | `/w/visual-audit/p/DP?issue=DP-26` | VD12, VD01, VD02 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| K3 · ขอเลื่อน Due | `/w/visual-audit/p/DP?issue=DP-2` | VD22, VD01, VD02 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| K4 · กระดิ่งแจ้งเตือน + Toast + Global top bar | `/w/visual-audit/p/DP` | VD24, VD01, VD02 | เปิดกระดิ่ง; Toast/ปุ่ม action อ้าง K4 และ source เพิ่มเติมจากภาพแผงกระดิ่ง |
| L1 · Backlog + Sprint planning | `/w/visual-audit/p/DP/backlog` | VD02, VD01 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| L2 · Project Settings | `/w/visual-audit/p/DP/settings/workflow` | VD02, VD01 | เทียบ Workflow active ตาม default ของ L2 ไม่ใช้ General เทียบ Workflow |
| M1 · สถานะหน้าจอ (Empty · Loading · Error · 403 · 404 · Viewer) | `/dev/ui` | ใกล้เคียง/ดูหมายเหตุ | M1 เป็นบอร์ดรวมรูปแบบสถานะ ไม่ใช่ route เดียว ดูภาพ 404/403/Error/Loading/Empty/Success ของ UI จริงแยกด้านล่าง |
| M2 · Mobile · My Tasks | `/w/visual-audit/my-tasks` | VD04, VD16 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| M3 · Mobile · Inbox | `/w/visual-audit/inbox` | VD04, VD16 | ใช้ list state ไม่มี ?n= เพื่อให้ตรง M3 ไม่เอา detail ที่เปิดแล้วไปเทียบ list |
| M4 · Mobile · Sub-task Detail | `/w/visual-audit/p/DP?issue=DP-25` | VD13, VD18 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| L3 · Import Excel + การแก้ไขแผน (Plan vs Actual) | `/w/visual-audit/import` | VD19, VD01 | อัปโหลด Excel สมมติและไป step 3 ตาม Canvas; ที่390ต้องใช้ Enter เพราะเมนูล่างบัง pointer ของปุ่มใน step2 ดู VD19 |
| N1 · Admin Console (Workspace / SaaS) | `/w/visual-audit/admin` | VD03, VD01 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| O1 · Lead Dashboard (ข้อมูลจริง Development Plan 2026-11) | `/w/visual-audit/p/DP/dashboard` | VD03, VD01, VD02 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| O2 · Reports + Requirement Traceability | `/w/visual-audit/p/DP/reports` | VD03, VD01, VD02 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| N2 · หน้าตาข้อความแจ้งเตือน (LINE · Email · Webhook) | `/w/visual-audit/admin/notify-templates` | VD03, VD01 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| M5 · Mobile · Home | `/w/visual-audit` | VD04, VD14 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| M6 · Mobile · Project Overview | `/w/visual-audit/p/DP` | VD04, VD05, VD15 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| M7 · Mobile · Kanban (ย้ายด้วยปุ่ม) | `/w/visual-audit/p/DP/board` | VD04, VD17 | เลือก In progress แล้วให้ตรง M7; มีข้อมูล6รายการในคอลัมน์ |
| P1 · ค้นหา + Command palette (Ctrl K) | `/w/visual-audit/p/DP` | VD25, VD01, VD02 | เปิด Command palette และพิมพ์คำค้นเดียวกับข้อมูลสมมติ; รูปแบบผลตามจำนวนข้อมูลไม่ใช้คิดเป็นคะแนน pixel |
| P2 · Automation (เมื่อ … ถ้า … ให้ …) | `/w/visual-audit/p/DP/automation` | VD03, VD01, VD02 | ดูรายการแก้และภาพเทียบ; แยกความต่างของข้อมูลตัวอย่างออกจากโครงหน้า |
| P3 · Dialog ยืนยัน + เลิกทำ | `/w/visual-audit/p/DP?issue=DP-1` | VD23, VD01, VD02 | เทียบ dialog ลบ Task ที่มี Sub-task; ไม่กดยืนยันลบ |
| Q1 · สลับ Workspace + สร้างใหม่ | `/w/visual-audit` | ใกล้เคียง/ดูหมายเหตุ | โครงหลักใกล้เคียงในสถานะที่เก็บภาพ ยังไม่ใช่การรับรองทุก interaction |
| Q2 · เมื่อใช้เกินแพ็กเกจ (7 สถานการณ์) | `/w/visual-audit/p/DP` | ใกล้เคียง/ดูหมายเหตุ | เทียบ seat-limit modal; ใช้ response402จำลองเฉพาะ browser เพื่อเปิดสถานะนี้ ไม่มีการเปลี่ยนแพ็กเกจ |
| Q3 · Super Admin (หลังบ้านทีม Friday) | `/workspaces?id=01a1b109-5e9e-71af-a255-df792c41914c` | ใกล้เคียง/ดูหมายเหตุ | ใช้ session ทดสอบของ staff สมมติ; โครง sidebar/list/detail ใกล้เคียง Q3; grant/ตัวเลขธุรกิจต่างตาม fixture ไม่ใช่ design defect |
| R1 · Landing + ราคาเหมาตามขนาดทีม (TH / EN) | `/` | ใกล้เคียง/ดูหมายเหตุ | hero/features/pricing layout ใกล้เคียง; ราคาและจำนวนคนที่ต่างเป็นข้อมูล catalog ไม่ใช่ pixel defect |
| R2 · ชำระเงิน (บัตร · PromptPay · โอน + หัก ณ ที่จ่าย) | `/w/visual-audit/billing/checkout?plan=team_m` | VD03, VD01 | เลือกโอนเงิน/ข้อมูลภาษีตัวอย่าง แต่ไม่กดขอ invoice หรือชำระ; ข้อมูลธนาคารในแบบกับสถานะก่อนออก invoice จริงเป็นคนละขั้นของข้อมูล |
| R3 · ภาษา TH / EN | `/w/visual-audit/profile?tab=profile` | ใกล้เคียง/ดูหมายเหตุ | R3 เป็นบอร์ดตัวอย่างและกติกา เปรียบเทียบ controls ที่ Profile และ Workspace menu ไม่ถือว่าตารางอธิบายใน Canvas เป็นหน้าที่ต้องสร้าง |
| R4 · หน้ากฎหมาย + Cookie consent | `/legal/terms` | ใกล้เคียง/ดูหมายเหตุ | เทียบเอกสาร terms และ Cookie consent; API ยังไม่มีเอกสารเผยแพร่จึงใช้ข้อความตัวอย่างของ UI — ไม่ได้อนุมัติเนื้อหากฎหมาย |

## ลำดับแก้ที่แนะนำ

1. W00: shell/header/context variants และ mobile navigation (VD01–04) เพราะกระทบหลายหน้า; ตรวจว่าไม่แก้ project/ops/public shell แบบเหมารวม
2. W05: Overview/Table composition (VD05–09) โดยไม่เปลี่ยน business logic
3. W02: create/detail/sub-task/dialog variants (VD10–13,18,22,23) และรวมข้อมูล QA/Git/files ที่พร้อมแล้ว
4. Mobile M2–M7 และ fixed footer/safe area (VD14–19) ให้ pointer CTA กดได้จริงที่390×844
5. Notification/Profile/Invite/Search/Wizard (VD20–26)

หลังแต่ละชุดให้เก็บภาพใหม่ด้วยข้อมูลและ state เดิม เทียบ viewport กับ full-page แยกกัน และระบุไฟล์ Canvas ที่ใช้ ห้ามติ๊ก visual acceptance ว่าผ่านจาก component test อย่างเดียว รายงานนี้เป็นผลตรวจ ไม่ได้แก้ source UI หรือ checkbox ของ task

## ผลตรวจหลังแก้

ผลด้านบนเป็น baseline commit46719fa; ตรวจ PR#79/commit844a671 แล้ว VD02ผ่านในขอบเขต desktop มือถือยังอยู่ VD04/VD15 ดู [รายงานตรวจซ้ำและเกณฑ์ชื่อยาวที่ปรับตามพฤติกรรม Canvas](canvas-vd02-verification-2026-11-06.md) และ [สถานะปัจจุบันทั้ง26รายการ](canvas-design-fixes-2026-11-06.md)
