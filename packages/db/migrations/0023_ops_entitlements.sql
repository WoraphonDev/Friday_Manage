CREATE TABLE "entitlement_overrides" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb,
	"expires_at" timestamp with time zone,
	"contract_ref" text,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"warned_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_overrides_expiry" CHECK ("entitlement_overrides"."expires_at" IS NOT NULL OR "entitlement_overrides"."contract_ref" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "entitlement_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"version" integer NOT NULL,
	"matrix" jsonb NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"restored_from" integer,
	"created_by" uuid,
	"approved_by" uuid,
	"approval_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_versions_version_unique" UNIQUE("version"),
	CONSTRAINT "entitlement_versions_version_positive" CHECK ("entitlement_versions"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "entitlement_overrides" ADD CONSTRAINT "entitlement_overrides_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_overrides" ADD CONSTRAINT "entitlement_overrides_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_overrides" ADD CONSTRAINT "entitlement_overrides_approved_by_staff_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_overrides" ADD CONSTRAINT "entitlement_overrides_revoked_by_staff_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_versions" ADD CONSTRAINT "entitlement_versions_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_versions" ADD CONSTRAINT "entitlement_versions_approved_by_staff_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_versions" ADD CONSTRAINT "entitlement_versions_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entitlement_overrides_workspace_idx" ON "entitlement_overrides" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_overrides_active_key" ON "entitlement_overrides" USING btree ("workspace_id","key") WHERE "entitlement_overrides"."revoked_at" IS NULL;--> statement-breakpoint

-- O21: ใช้เฉพาะทีม Friday (ops-api) และ API ลูกค้าอ่านผ่าน SYSTEM_DB ตอนตรวจขีดจำกัด · แอปของลูกค้าแตะตรงไม่ได้
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['entitlement_versions', 'entitlement_overrides'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM friday_app', t);
    EXECUTE format('CREATE POLICY ops_only ON public.%I TO friday_app USING (false) WITH CHECK (false)', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- เวอร์ชันเป็นประวัติ: แก้หรือลบไม่ได้ (กู้เวอร์ชันเก่า = สร้างเวอร์ชันใหม่)
REVOKE UPDATE, DELETE, TRUNCATE ON public.entitlement_versions FROM friday_system;
--> statement-breakpoint
CREATE TRIGGER touch BEFORE UPDATE ON public.entitlement_overrides FOR EACH ROW EXECUTE FUNCTION app.touch();
--> statement-breakpoint
-- เวอร์ชัน 1 = ค่าที่ใช้อยู่ก่อนมีหน้านี้ (DEFAULT_MATRIX ใน src/plan-entitlements.ts)
INSERT INTO public.entitlement_versions (version, matrix, effective_at, reason)
VALUES (1, '{"free":{"seats":5,"projects":3,"storage_gb_per_member":1,"automation_runs":100,"api_rpm":0,"history_days":30,"gantt":false,"import_update":false,"channels":false,"automation":false,"api":false,"guests":true,"sso":false,"sla":false},"team_s":{"seats":10,"projects":null,"storage_gb_per_member":10,"automation_runs":5000,"api_rpm":60,"history_days":365,"gantt":true,"import_update":true,"channels":true,"automation":true,"api":true,"guests":true,"sso":false,"sla":false},"team_m":{"seats":25,"projects":null,"storage_gb_per_member":10,"automation_runs":20000,"api_rpm":120,"history_days":365,"gantt":true,"import_update":true,"channels":true,"automation":true,"api":true,"guests":true,"sso":false,"sla":false},"team_l":{"seats":50,"projects":null,"storage_gb_per_member":10,"automation_runs":50000,"api_rpm":300,"history_days":1095,"gantt":true,"import_update":true,"channels":true,"automation":true,"api":true,"guests":true,"sso":false,"sla":false},"enterprise":{"seats":null,"projects":null,"storage_gb_per_member":null,"automation_runs":null,"api_rpm":1000,"history_days":null,"gantt":true,"import_update":true,"channels":true,"automation":true,"api":true,"guests":true,"sso":true,"sla":true}}'::jsonb, '2026-01-01T00:00:00+07:00', 'เวอร์ชันเริ่มต้น (ค่าเดิมในโค้ด)');
