CREATE TABLE "diagrams" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"template" text DEFAULT 'blank' NOT NULL,
	"content" jsonb DEFAULT '{"nodes":[],"edges":[]}'::jsonb NOT NULL,
	"issue_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"locked_by" uuid,
	"locked_until" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "diagrams_workspace_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "diagrams_template" CHECK ("diagrams"."template" IN ('blank', 'flowchart', 'er', 'architecture', 'whiteboard'))
);
--> statement-breakpoint
ALTER TABLE "diagrams" ADD CONSTRAINT "diagrams_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagrams" ADD CONSTRAINT "diagrams_locked_by_users_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagrams" ADD CONSTRAINT "diagrams_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagrams" ADD CONSTRAINT "diagrams_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagrams" ADD CONSTRAINT "diagrams_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagrams" ADD CONSTRAINT "diagrams_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "diagrams_project_idx" ON "diagrams" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE INDEX "diagrams_issue_ids_idx" ON "diagrams" USING gin ("issue_ids");--> statement-breakpoint
CREATE INDEX "diagrams_name_trgm_idx" ON "diagrams" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "diagrams_trash_idx" ON "diagrams" USING btree ("workspace_id","deleted_at") WHERE "diagrams"."deleted_at" IS NOT NULL;--> statement-breakpoint
-- ไม่ใส่ trigger touch: ล็อก/heartbeat ไม่นับเป็นการแก้ · API ตั้ง updated_at เองเมื่อบันทึกเนื้อหา
-- RLS: แยก Workspace + ต้องเข้าถึงโปรเจกต์ได้ เหมือน files
ALTER TABLE public.diagrams ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.diagrams TO friday_app
  USING (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()))
  WITH CHECK (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()));
--> statement-breakpoint
CREATE POLICY project_access ON public.diagrams AS RESTRICTIVE TO friday_app
  USING (project_id IN (SELECT app.accessible_project_ids()))
  WITH CHECK (project_id IN (SELECT app.accessible_project_ids()));
--> statement-breakpoint
-- ผู้ลบสำหรับถังขยะ (A41)
CREATE TRIGGER soft_delete BEFORE INSERT OR UPDATE OF deleted_at ON public.diagrams FOR EACH ROW EXECUTE FUNCTION app.track_soft_delete();
