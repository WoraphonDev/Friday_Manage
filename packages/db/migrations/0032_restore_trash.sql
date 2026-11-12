DROP INDEX "projects_workspace_key_key";--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "purge_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "purge_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspaces_purge_idx" ON "workspaces" USING btree ("purge_after") WHERE "workspaces"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "projects_trash_idx" ON "projects" USING btree ("workspace_id","deleted_at") WHERE "projects"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "issues_trash_idx" ON "issues" USING btree ("workspace_id","deleted_at") WHERE "issues"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "files_trash_idx" ON "files" USING btree ("workspace_id","deleted_at") WHERE "files"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_workspace_key_key" ON "projects" USING btree ("workspace_id","key") WHERE "projects"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_purge_after_deleted" CHECK ("workspaces"."purge_after" IS NULL OR "workspaces"."deleted_at" IS NOT NULL);--> statement-breakpoint

-- O30: ผู้ลบและวันลบถาวรตั้งในฐานข้อมูล เพื่อให้ทุกทางที่ลบ (API ลูกค้า, นำเข้า Excel, ops-api) ได้ค่าเดียวกันโดยไม่ต้องแก้ทุก service
-- ผู้ลบ = ค่าที่ API ส่งมา หรือ app.user_id ของธุรกรรม (ตรวจว่ามีผู้ใช้จริงเพราะมี FK) · กู้คืนแล้วล้างค่า
CREATE FUNCTION app.track_soft_delete() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.deleted_at IS NULL THEN
    NEW.deleted_by := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.deleted_by := coalesce(NEW.deleted_by, (SELECT u.id FROM public.users u WHERE u.id = app.user_id()));
  ELSIF OLD.deleted_at IS NULL THEN
    NEW.deleted_by := coalesce(NEW.deleted_by, (SELECT u.id FROM public.users u WHERE u.id = app.user_id()));
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- Workspace: ระยะผ่อนผัน 30 วัน (03-api › DELETE w/) · ทีม Friday ยืด purge_after ได้ภายหลัง (O31) จึงไม่ทับค่าที่ส่งมา
CREATE FUNCTION app.workspace_soft_delete() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.deleted_at IS NULL THEN
    NEW.deleted_by := NULL;
    NEW.purge_after := NULL;
    NEW.purge_reminded_at := NULL;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.deleted_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
  END IF;
  NEW.deleted_by := coalesce(NEW.deleted_by, (SELECT u.id FROM public.users u WHERE u.id = app.user_id()));
  NEW.purge_after := coalesce(NEW.purge_after, NEW.deleted_at + interval '30 days');
  RETURN NEW;
END
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.track_soft_delete(), app.workspace_soft_delete() TO friday_app, friday_system;
--> statement-breakpoint

-- ย้ายข้อมูลเดิม · ปิด trigger touch ชั่วคราวเพื่อไม่ให้ updated_at / version ของแถวในถังขยะเปลี่ยน
-- ผู้ลบของแถวเดิมเอาจากประวัติที่มีอยู่: งาน = activities (verb deleted) · โปรเจกต์ / ไฟล์ / Workspace = audit_logs
ALTER TABLE public.workspaces DISABLE TRIGGER touch;
--> statement-breakpoint
UPDATE public.workspaces w SET
  purge_after = w.deleted_at + interval '30 days',
  deleted_by = (SELECT a.actor_id FROM public.audit_logs a JOIN public.users u ON u.id = a.actor_id
    WHERE a.workspace_id = w.id AND a.action = 'workspace.deleted' ORDER BY a.created_at DESC LIMIT 1)
WHERE w.deleted_at IS NOT NULL AND w.purge_after IS NULL;
--> statement-breakpoint
ALTER TABLE public.workspaces ENABLE TRIGGER touch;
--> statement-breakpoint
ALTER TABLE public.projects DISABLE TRIGGER touch;
--> statement-breakpoint
UPDATE public.projects p SET deleted_by = (SELECT a.actor_id FROM public.audit_logs a JOIN public.users u ON u.id = a.actor_id
    WHERE a.workspace_id = p.workspace_id AND a.target_id = p.id AND a.action = 'project.deleted' ORDER BY a.created_at DESC LIMIT 1)
WHERE p.deleted_at IS NOT NULL AND p.deleted_by IS NULL;
--> statement-breakpoint
ALTER TABLE public.projects ENABLE TRIGGER touch;
--> statement-breakpoint
ALTER TABLE public.issues DISABLE TRIGGER touch;
--> statement-breakpoint
UPDATE public.issues i SET deleted_by = (SELECT a.actor_id FROM public.activities a JOIN public.users u ON u.id = a.actor_id
    WHERE a.workspace_id = i.workspace_id AND a.issue_id = i.id AND a.verb = 'deleted' ORDER BY a.created_at DESC LIMIT 1)
WHERE i.deleted_at IS NOT NULL AND i.deleted_by IS NULL;
--> statement-breakpoint
ALTER TABLE public.issues ENABLE TRIGGER touch;
--> statement-breakpoint
UPDATE public.files f SET deleted_by = (SELECT a.actor_id FROM public.audit_logs a JOIN public.users u ON u.id = a.actor_id
    WHERE a.workspace_id = f.workspace_id AND a.target_id = f.id AND a.action = 'file.deleted' ORDER BY a.created_at DESC LIMIT 1)
WHERE f.deleted_at IS NOT NULL AND f.deleted_by IS NULL;
--> statement-breakpoint

-- ติดตั้ง trigger หลังย้ายข้อมูล · BEFORE จึงตั้งค่าก่อนตรวจ CHECK workspaces_purge_after_deleted
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['projects', 'issues', 'files'] LOOP
    EXECUTE format('CREATE TRIGGER soft_delete BEFORE INSERT OR UPDATE OF deleted_at ON public.%I FOR EACH ROW EXECUTE FUNCTION app.track_soft_delete()', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TRIGGER soft_delete BEFORE INSERT OR UPDATE OF deleted_at ON public.workspaces FOR EACH ROW EXECUTE FUNCTION app.workspace_soft_delete();