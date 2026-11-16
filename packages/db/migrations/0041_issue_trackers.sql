-- IF NOT EXISTS: ฐาน QA ในเครื่องเพิ่มคอลัมน์นี้ไว้ก่อน merge จึงรันซ้ำได้
ALTER TABLE "workspace_settings" ADD COLUMN IF NOT EXISTS "issue_trackers" jsonb DEFAULT '[]'::jsonb NOT NULL;
