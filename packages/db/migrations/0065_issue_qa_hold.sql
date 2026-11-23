ALTER TABLE "issues" ADD COLUMN "qa_hold_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "qa_since" date;--> statement-breakpoint
-- หยุดนาฬิกา Due ของ Dev ระหว่างงานอยู่ช่วง QA (หมวด review) แล้วนับต่อเมื่อ QA ตีกลับ (ผู้ใช้ขอ 2026-11-23)
-- ใช้ trigger เพราะสถานะถูกแก้จากหลายทาง (Drawer, Board, Automation, Git, นำเข้า, เปลี่ยน Workflow)
-- เก็บทุกโปรเจกต์ (ถูกกว่าเช็ก progress_split ทุกครั้ง) · API ใช้ค่าเฉพาะโปรเจกต์ที่แยก Dev / QA (projects/due-stage.ts)
CREATE FUNCTION app.track_qa_hold() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  in_qa boolean;
  d date := (now() AT TIME ZONE 'Asia/Bangkok')::date;
BEGIN
  SELECT category::text = 'review' INTO in_qa FROM public.workflow_statuses WHERE id = NEW.status_id;
  IF coalesce(in_qa, false) THEN
    NEW.qa_since := coalesce(NEW.qa_since, d);
  ELSIF NEW.qa_since IS NOT NULL THEN
    NEW.qa_hold_days := NEW.qa_hold_days + greatest(d - NEW.qa_since, 0);
    NEW.qa_since := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER track_qa_hold BEFORE INSERT OR UPDATE OF status_id ON public.issues
  FOR EACH ROW EXECUTE FUNCTION app.track_qa_hold();
--> statement-breakpoint
-- เทียบหมวดเป็น text: อัปเกรดฐานเก่าใน transaction เดียว ค่า enum 'review' (0028) ยังไม่ commit จึงแปลงเป็น enum ไม่ได้
-- เติมค่าจากประวัติการเปลี่ยนสถานะ (activities field = statusId) เพื่อให้งานที่เคยถูก QA ตีกลับนับต่อได้ทันที
-- สถานะที่ถูกลบไปแล้วหาหมวดไม่ได้ = ไม่ถือว่าอยู่ช่วง QA · ไม่แตะ updated_at / version (ไม่ใช่การแก้งานของผู้ใช้)
ALTER TABLE public.issues DISABLE TRIGGER touch;
--> statement-breakpoint
WITH ch AS (
  SELECT a.issue_id, a.created_at,
    (a.created_at AT TIME ZONE 'Asia/Bangkok')::date AS d,
    coalesce(o.category::text = 'review', false) AS was_qa,
    coalesce(n.category::text = 'review', false) AS is_qa
  FROM public.activities a
  LEFT JOIN public.workflow_statuses o ON o.id = CASE WHEN a.old_value #>> '{}' ~* '^[0-9a-f-]{36}$' THEN (a.old_value #>> '{}')::uuid END
  LEFT JOIN public.workflow_statuses n ON n.id = CASE WHEN a.new_value #>> '{}' ~* '^[0-9a-f-]{36}$' THEN (a.new_value #>> '{}')::uuid END
  WHERE a.field = 'statusId' AND a.issue_id IS NOT NULL
),
held AS (
  -- ออกจากช่วง QA แต่ละครั้ง นับจากการเข้าช่วง QA ครั้งล่าสุดก่อนหน้า (ไม่มีประวัติการเข้า = ไม่นับ)
  SELECT x.issue_id, sum(greatest(x.d - e.d, 0))::int AS days
  FROM ch x
  CROSS JOIN LATERAL (
    SELECT max(y.d) AS d FROM ch y
    WHERE y.issue_id = x.issue_id AND y.is_qa AND NOT y.was_qa AND y.created_at <= x.created_at
  ) e
  WHERE x.was_qa AND NOT x.is_qa AND e.d IS NOT NULL
  GROUP BY x.issue_id
),
entered AS (
  SELECT issue_id, max(d) AS d FROM ch WHERE is_qa AND NOT was_qa GROUP BY issue_id
)
UPDATE public.issues i SET
  qa_hold_days = coalesce((SELECT h.days FROM held h WHERE h.issue_id = i.id), 0),
  -- อยู่ช่วง QA ตอนนี้: เริ่มนับจากวันที่เข้าครั้งล่าสุด · ไม่มีประวัติ = วันนี้ (ไม่ให้วันพักเกินจริง)
  qa_since = CASE WHEN ws.category::text = 'review'
    THEN coalesce((SELECT en.d FROM entered en WHERE en.issue_id = i.id), (now() AT TIME ZONE 'Asia/Bangkok')::date) END
FROM public.workflow_statuses ws
WHERE ws.id = i.status_id
  AND (ws.category::text = 'review' OR i.id IN (SELECT issue_id FROM held));
--> statement-breakpoint
ALTER TABLE public.issues ENABLE TRIGGER touch;
