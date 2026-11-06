-- BUG-13: ปิด In-app แล้วยังต้องส่ง Email / LINE ได้ · แจ้งเตือนที่ in_app = false เป็นต้นทางของการส่งออกนอกแอปเท่านั้น
ALTER TABLE "notifications" ADD COLUMN "in_app" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- ซ่อนจาก Inbox / ตัวนับ / Home ของผู้รับทุกที่ในคราวเดียว (คำขอผ่าน friday_app) · งานเบื้องหลังใช้ friday_system จึงยังอ่านได้
DROP POLICY own_notifications ON public.notifications;--> statement-breakpoint
CREATE POLICY own_notifications ON public.notifications TO friday_app
  USING (recipient_id = (SELECT app.user_id()) AND in_app)
  WITH CHECK (recipient_id = (SELECT app.user_id()));
