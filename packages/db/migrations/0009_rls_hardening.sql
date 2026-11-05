-- T00 Review: ปิดช่องโหว่ RLS / constraint ที่พบหลัง 0008 · เพิ่มอย่างเดียว ไม่แก้ migration ที่รันแล้ว
DROP INDEX "verified_domains_domain_key";--> statement-breakpoint
CREATE UNIQUE INDEX "verified_domains_workspace_domain_key" ON "verified_domains" USING btree ("workspace_id",lower("domain"));--> statement-breakpoint
CREATE UNIQUE INDEX "verified_domains_domain_key" ON "verified_domains" USING btree (lower("domain")) WHERE "verified_domains"."verified_at" IS NOT NULL;--> statement-breakpoint

-- ประวัติส่งออกนอกแอปมีอีเมล / LINE ID ของผู้รับ จึงต้องตามสิทธิ์ของ notifications (เห็นเฉพาะของตัวเอง)
-- Workspace Owner / Admin เห็นทั้งหมดสำหรับหน้า w/channels/deliveries
CREATE POLICY recipient_or_admin ON public.notification_deliveries AS RESTRICTIVE FOR SELECT TO friday_app
  USING (notification_id IN (SELECT id FROM public.notifications) OR (SELECT app.is_ws_admin()));
--> statement-breakpoint
-- งานเบื้องหลังเป็นผู้สร้างและอัปเดตสถานะการส่ง (เหมือน notifications ใน 0001)
REVOKE INSERT, UPDATE, DELETE ON public.notification_deliveries FROM friday_app;
--> statement-breakpoint

-- สิทธิ์ support เปิดให้ทีม Friday เข้า Workspace ได้ จึงตรวจ Owner ซ้ำที่ฐานข้อมูลนอกจาก API
-- สมาชิกยังอ่านสถานะได้ตาม tenant_isolation ของ 0008
CREATE POLICY owner_insert ON public.support_access_grants AS RESTRICTIVE FOR INSERT TO friday_app
  WITH CHECK ((SELECT app.ws_role()) = 'owner' AND granted_by = (SELECT app.user_id()));
--> statement-breakpoint
CREATE POLICY owner_update ON public.support_access_grants AS RESTRICTIVE FOR UPDATE TO friday_app
  USING ((SELECT app.ws_role()) = 'owner')
  WITH CHECK ((SELECT app.ws_role()) = 'owner');
--> statement-breakpoint
CREATE POLICY owner_delete ON public.support_access_grants AS RESTRICTIVE FOR DELETE TO friday_app
  USING ((SELECT app.ws_role()) = 'owner');
