# 05 · ข้อมูลธุรกิจและตัวชี้วัด

**สถานะ:** ร่างแรก (9 พ.ย. 2569) · หน้าจอ "16 · ธุรกิจและกำไร" และการ์ด "กำไรจากลูกค้ารายนี้" / "สัญญาณพร้อมอัปเกรด" ใน [Canvas Friday Ops](https://claude.ai/artifact/Q8tsmLfQqS1aUJ2rNrkw9r) · ยังไม่มี migration

เอกสารนี้บอกว่าต้องเก็บอะไร**ตั้งแต่วันเปิดตัว** เพื่อให้ตอบ 4 คำถามของเจ้าของระบบได้:

1. ลูกค้าแต่ละรายกำไรหรือขาดทุน
2. คนสมัครแล้วไปติดอยู่ตรงไหน
3. ลูกค้ามาจากไหน และคุ้มกับเงินที่จ่ายไปไหม
4. ใครกำลังจะยกเลิก และใครพร้อมจ่ายเพิ่ม

**ทำไมต้องรีบ:** ตัวเลขส่วนใหญ่คำนวณย้อนหลังจากตารางที่มีได้ แต่ข้อมูล 4 กลุ่มในส่วนที่ 1 **เก็บย้อนหลังไม่ได้** ถ้าไม่เก็บตั้งแต่ลูกค้ารายแรก จะไม่มีวันรู้ว่าลูกค้ากลุ่มแรกมาจากไหนหรือเลิกเพราะอะไร

---

## 1. ข้อมูลที่ต้องเก็บตั้งแต่เฟสแรก

### 1.1 ที่มาของลูกค้า

| Entity | ใช้ทำอะไร | ฟิลด์หลัก | ระดับ |
|---|---|---|---|
| `signup_attributions` | ช่องทางที่ผู้ใช้มาครั้งแรก (1:1 กับ `user`) | user_id, utm_source, utm_medium, utm_campaign, utm_term, referrer_host, landing_path, via (direct · invited · ops_created), invited_by_user_id, invited_workspace_id, first_seen_at | ระบบ |
| `workspace_acquisitions` | ที่มาของ Workspace (คัดลอกจากผู้สร้างตอนสร้าง) | workspace_id (PK), source, medium, campaign, referrer_host, via (signup · invited_user · sales · ops_created), referring_workspace_id (เมื่อผู้สร้างเคยถูกชวนเข้า Workspace อื่น) | ระบบ |

- เว็บเก็บ UTM / referrer ของการเข้าครั้งแรกไว้ใน cookie ของโดเมนเราเอง (first-party, อายุ 30 วัน) แล้วส่งมากับ `POST auth/signup`
- เก็บ `referrer_host` เท่านั้น ไม่เก็บ URL เต็ม เพราะ URL อาจมีข้อมูลส่วนตัว
- `via = invited` ใช้วัด "ถูกชวนแล้วไปเปิด Workspace เอง" (การโตที่ไม่ต้องจ่ายค่าโฆษณา)

### 1.2 เหตุการณ์ในแอป (ใช้ทำ Funnel และการใช้ฟีเจอร์)

| Entity | ใช้ทำอะไร | ฟิลด์หลัก |
|---|---|---|
| `product_events` | เหตุการณ์ที่ดูจากตารางอื่นไม่ได้ · append-only · แบ่ง partition รายเดือน · เก็บ 25 เดือน | id, workspace_id, user_id (null = ระบบ), name, props (jsonb), occurred_at |

เก็บ**เฉพาะเหตุการณ์ที่หาจากตารางอื่นไม่ได้** เช่น การเปิดดูหน้า ส่วนเหตุการณ์ที่มีแถวอยู่แล้ว เช่น สร้างงาน หรือชวนสมาชิก ให้นับจากตารางเดิม (`issue.created_at`, `workspace_member`)

| name | เกิดเมื่อ | props | ใช้ตอบ |
|---|---|---|---|
| `feature.used` | ใช้ฟีเจอร์ครั้งแรกของวัน (ต่อคน ต่อฟีเจอร์) | feature (table · kanban · gantt · timeline · calendar · workload · due_request · import · automation · saved_view · git · api · line · report) | การใช้ฟีเจอร์ · คะแนนสุขภาพ |
| `limit.hit` | ชนขีดจำกัดของแพ็กเกจ | limit (seats · storage · automation · projects · guests · feature), current, max | สัญญาณพร้อมอัปเกรด |
| `upgrade.prompt_shown` / `upgrade.prompt_clicked` | เห็น / กดปุ่มอัปเกรด | placement, plan_from, plan_to | การตอบรับของปุ่มอัปเกรด |
| `onboarding.step_done` | ทำขั้นใน Onboarding checklist | step | ขั้นที่ลูกค้าติด |
| `checkout.started` / `checkout.method_selected` | เปิดหน้าชำระเงิน / เลือกช่องทาง | plan, cycle, method | คนที่เปิดหน้าจ่ายแต่ไม่จ่าย |

- ส่งผ่าน `EventBus.publish` แบบเดียวกับ `issue.created` แล้วให้ module `analytics` ฟังใน `onModuleInit` และเขียนแบบ batch · **ห้ามทำให้คำขอของลูกค้าช้าหรือล้ม** ถ้าเขียนไม่สำเร็จให้ทิ้งเหตุการณ์นั้น
- `props` **ห้ามมีเนื้อหาของลูกค้า** (ชื่องาน คอมเมนต์ ชื่อไฟล์ อีเมล) มีได้แค่ชื่อฟีเจอร์และตัวเลข
- `feature.used` ฝั่ง browser ส่งผ่าน `POST w/events` (รับเป็นชุด สูงสุด 50 รายการ) และ API ตรวจว่า `name` / `feature` อยู่ในรายการที่อนุญาต
- ไม่ใช้ SDK วิเคราะห์ของบุคคลที่สามในแอปลูกค้า เพื่อไม่ให้ข้อมูลออกนอกระบบ และไม่ต้องขอ cookie consent เพิ่ม

### 1.3 ประวัติแพ็กเกจและเหตุผลที่ยกเลิก

`subscription` เก็บแค่สถานะปัจจุบัน จึงทำ MRR movement และ cohort ย้อนหลังไม่ได้

| Entity | ใช้ทำอะไร | ฟิลด์หลัก |
|---|---|---|
| `subscription_changes` | ทุกครั้งที่ MRR ของ Workspace เปลี่ยน · append-only | workspace_id, kind (new · upgrade · downgrade · seats_up · seats_down · cycle_change · cancel · reactivate · churn_payment), plan_from, plan_to, seats_from, seats_to, mrr_before_satang, mrr_after_satang, actor_kind (user · system · staff), actor_id, effective_at |
| `cancellation_responses` | คำตอบตอนกดยกเลิก (ต้องตอบก่อนยืนยัน) | workspace_id, user_id, reason (too_expensive · missing_feature · switched_tool · project_ended · hard_to_use · company_closed · other), missing_feature (ข้อความ), switched_to (ข้อความ), detail, offer_shown (none · discount · pause), outcome (canceled · kept), created_at |

- MRR คิดก่อน VAT หลังหักส่วนลด · แพ็กเกจรายปีหาร 12 · เก็บเป็นสตางค์
- `churn_payment` = ยกเลิกเพราะตัดเงินไม่ผ่านจนครบกำหนดระงับ แยกจากการยกเลิกโดยตั้งใจ

### 1.4 การใช้ทรัพยากรและต้นทุน

| Entity | ใช้ทำอะไร | ฟิลด์หลัก | ระดับ |
|---|---|---|---|
| `daily_usages` | ยอดใช้ต่อ Workspace ต่อวัน (job ตอน 01:00) | workspace_id, date, line_messages, emails, webhook_calls, storage_bytes (ยอดคงเหลือ), api_calls, automation_runs, active_users | ลูกค้า |
| `cost_rates` | ต้นทุนต่อหน่วย (ทีม Friday ตั้งในหลังบ้าน) | resource (line_message · email · storage_gb_month · payment_fee_pct · etax_doc · slip_check), unit_cost_satang หรือ pct, effective_from | ระบบ |
| `infra_costs` | ค่าใช้จ่ายส่วนกลางรายเดือน (ดึงจาก AWS Cost Explorer + กรอกเอง) | month, category (aws · tools · other), amount_satang | ระบบ |
| `marketing_costs` | ค่าการตลาดรายเดือนตามช่องทาง (ทีม Friday กรอก) | month, source, amount_satang, note | ระบบ |

- `daily_usages` นับจาก `notification_delivery` (status = sent), `file_version` และ log ของ API · job ใช้ `SYSTEM_DB` เพราะรวมทุก Workspace (เขียนเหตุผลไว้ในคอมเมนต์)
- ต้นทุนของลูกค้า 1 ราย = Σ(usage × `cost_rates`) + ค่าธรรมเนียมรับเงินจริงจาก `payment` + ส่วนแบ่ง `infra_costs` ตามสัดส่วนผู้ใช้งาน

---

## 2. ตัวชี้วัด (คำนวณ ไม่เก็บในตาราง)

| ตัวชี้วัด | คำนวณจาก |
|---|---|
| MRR / ARR | ผลรวม `mrr_after_satang` ล่าสุดของแต่ละ Workspace ที่ active · ARR = MRR × 12 |
| MRR movement | `subscription_changes` ในช่วงเวลา แยกตาม kind |
| Net revenue retention | MRR วันนี้ของลูกค้าที่จ่ายอยู่เมื่อ 12 เดือนก่อน ÷ MRR ของกลุ่มเดียวกันเมื่อ 12 เดือนก่อน |
| อัตรายกเลิก (logo / revenue) | Workspace หรือ MRR ที่ยกเลิกในเดือน ÷ ต้นเดือน · แยก `churn_payment` |
| กำไรขั้นต้น | (MRR − ต้นทุนตาม 1.4) ÷ MRR · ต่อ Workspace / แพ็กเกจ / ทั้งระบบ |
| Funnel | สมัคร (`workspace.created_at`) → ยืนยันอีเมล → โปรเจกต์แรก → สมาชิกคนที่ 2 → เริ่มใช้จริง → จ่ายเงิน (`subscription_change.kind = new`) |
| เริ่มใช้จริง (activation) | **ร่าง:** สมาชิก ≥ 3 คน และสร้างงาน ≥ 10 งาน ภายใน 7 วันหลังสร้าง Workspace · ปรับเมื่อมีข้อมูลจริงว่านิยามไหนทำนายการจ่ายเงินได้ดีที่สุด |
| ทดลองใช้ → จ่ายเงิน | Workspace ที่ทดลองหมดในช่วง และมี `new` ภายใน 14 วันหลังหมด |
| Cohort | จัดกลุ่มตามเดือนที่ `kind = new` · % ที่ยังจ่ายในเดือนที่ n |
| ค่าหาลูกค้า (CAC) | `marketing_costs` ของช่องทาง ÷ ลูกค้าใหม่ที่จ่ายเงินจากช่องทางนั้น |
| LTV | รายได้เฉลี่ยต่อ Workspace × กำไรขั้นต้น % ÷ revenue churn รายเดือน |
| คืนทุนค่าหาลูกค้า | CAC ÷ (รายได้เฉลี่ยต่อเดือน × กำไรขั้นต้น %) |
| การใช้ฟีเจอร์ | Workspace ที่จ่ายเงินและมี `feature.used` ใน 30 วัน ÷ Workspace ที่จ่ายเงินทั้งหมด |
| สัญญาณพร้อมอัปเกรด | ที่นั่งใช้ ≥ 80% · `limit.hit` ≥ 3 ครั้งใน 14 วัน · Guest ≥ ที่นั่ง · พื้นที่ ≥ 90% · จ่ายรายเดือนตรงเวลา ≥ 6 รอบ |
| ค้างรับตามอายุ | `invoice` ที่ยังไม่ paid แยก 0–30 · 31–60 · > 60 วันหลัง due_date |
| รายได้รับล่วงหน้า | ส่วนของแพ็กเกจรายปีที่ชำระแล้วแต่ยังไม่ถึงเดือนที่รับรู้ |

คำนวณทุกคืนแล้วเก็บผลไว้ใน cache ไม่ต้องสร้างตารางสรุปจนกว่าจะช้า (ตามธรรมเนียมใน 01-entities › ค่าที่คำนวณ)

---

## 3. PDPA และความเป็นส่วนตัว

- ใช้ฐาน "ประโยชน์โดยชอบด้วยกฎหมาย" เพื่อปรับปรุงบริการ · เขียนไว้ในนโยบายความเป็นส่วนตัวว่าเก็บอะไร เก็บนานเท่าไร
- ผู้ใช้ลบบัญชี → `product_event.user_id` และ `signup_attributions` ถูกลบ / เป็น null · ตัวเลขรวมยังอยู่
- ทีม Friday เห็นข้อมูลนี้เป็นตัวเลขรวมและรายชื่อ Workspace เท่านั้น ไม่เห็นเนื้อหางาน
- ทุกตารางที่มี `workspace_id` เปิด RLS ตามปกติ · หน้า Friday Ops อ่านผ่าน ops-api

---

## 4. ลำดับการทำ

| เฟส | ทำอะไร | เหตุผล |
|---|---|---|
| ก่อนเปิดตัว | 1.1 ที่มาของลูกค้า · 1.3 ประวัติแพ็กเกจ + แบบสอบถามตอนยกเลิก · `daily_usages` · `feature.used` / `limit.hit` | เก็บย้อนหลังไม่ได้ |
| หลังมีลูกค้าจ่ายเงิน | `cost_rates`, `infra_costs`, `marketing_costs` + หน้า "ธุรกิจและกำไร" ใน Friday Ops | คำนวณย้อนหลังจากข้อมูลเฟสแรกได้ |
| เมื่อมีข้อมูล 3 เดือน | ยืนยันนิยาม "เริ่มใช้จริง" · คาดการณ์ MRR · ปรับน้ำหนักคะแนนสุขภาพ | ต้องมีข้อมูลจริงก่อน |

## 5. คำถามที่รอตัดสิน

| # | เรื่อง | ตอนนี้ร่างไว้แบบไหน |
|---|---|---|
| 1 | นิยาม "เริ่มใช้จริง" | สมาชิก ≥ 3 และงาน ≥ 10 ภายใน 7 วัน |
| 2 | ระยะเก็บ `product_events` | 25 เดือน (เทียบปีต่อปีได้) |
| 3 | ราคา LINE ต่อข้อความที่ใช้คิดต้นทุน | รอเลือกแพ็กเกจ LINE OA |
| 4 | ใส่โควตา LINE ในแพ็กเกจหรือไม่ | หน้าจอแนะนำให้ใส่ เพราะลูกค้า Team S บางรายขาดทุนจากค่า LINE |
