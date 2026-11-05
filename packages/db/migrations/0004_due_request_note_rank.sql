-- เหตุผลของผู้อนุมัติ / ปฏิเสธคำขอเลื่อน Due (K3, G)
ALTER TABLE "due_change_requests" ADD COLUMN "decision_note" text;--> statement-breakpoint

-- ลากการ์ดใน Kanban / Backlog เปลี่ยนแค่ rank (ลำดับ) และอาจต้องจัดลำดับใหม่ทั้งคอลัมน์
-- ไม่ควรทำให้ version ของงานเพิ่ม (ไม่อย่างนั้นคนที่กำลังแก้งานในคอลัมน์เดียวกันจะได้ 409 ทั้งที่ไม่มีใครแก้เนื้อหา)
-- จึงข้าม rank เหมือน issue_seq ใน 0003
CREATE OR REPLACE FUNCTION app.touch() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'issue_seq' - 'rank' - 'updated_at' - 'version') = (to_jsonb(OLD) - 'issue_seq' - 'rank' - 'updated_at' - 'version') THEN
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  IF TG_ARGV[0] = 'versioned' THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END
$$;
