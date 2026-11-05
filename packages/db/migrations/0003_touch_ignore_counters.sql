-- ออกเลขงานด้วย UPDATE projects SET issue_seq = issue_seq + 1 ทุกครั้งที่สร้างงาน
-- ไม่ควรทำให้ version ของโปรเจกต์เพิ่ม (ไม่อย่างนั้นคนที่กำลังแก้ Project Settings จะได้ 409 ทั้งที่ไม่มีใครแก้)
-- จึงข้าม updated_at / version เมื่อคอลัมน์ที่เปลี่ยนมีแค่ตัวนับ
CREATE OR REPLACE FUNCTION app.touch() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'issue_seq' - 'updated_at' - 'version') = (to_jsonb(OLD) - 'issue_seq' - 'updated_at' - 'version') THEN
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  IF TG_ARGV[0] = 'versioned' THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END
$$;
