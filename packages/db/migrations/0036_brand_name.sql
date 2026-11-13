-- ชื่อระบบเปลี่ยนเป็น Friday Work Management (ผู้ใช้ตัดสิน 2026-11-14)
ALTER TABLE "nps_settings" ALTER COLUMN "question" SET DEFAULT 'คุณจะแนะนำ Friday Work Management ให้เพื่อนหรือเพื่อนร่วมงานไหม';--> statement-breakpoint
-- เปลี่ยนเฉพาะคำถามที่ยังเป็นค่าตั้งต้นเดิม · คำถามที่ทีมแก้เองใน Ops คงไว้
UPDATE "nps_settings" SET "question" = 'คุณจะแนะนำ Friday Work Management ให้เพื่อนหรือเพื่อนร่วมงานไหม' WHERE "question" = 'คุณจะแนะนำ Friday Manage ให้เพื่อนหรือเพื่อนร่วมงานไหม';
