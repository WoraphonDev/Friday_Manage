-- A31: ลูกค้าต้องเปิด/ปิดสิทธิ์ support เองผ่าน TenantDb ได้
-- RLS แยก Workspace; สิทธิ์ Owner ของ action ตรวจที่ API ตาม 04-permissions
DROP POLICY ops_only ON public.support_access_grants;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.support_access_grants TO friday_app;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.support_access_grants TO friday_app
  USING (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()))
  WITH CHECK (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()));
