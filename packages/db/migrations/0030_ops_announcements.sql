CREATE TABLE "announcement_dismissals" (
	"announcement_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcement_dismissals_announcement_id_workspace_id_user_id_pk" PRIMARY KEY("announcement_id","workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "announcement_targets" (
	"announcement_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"recipients" integer,
	"banner_title" text,
	"banner_message" text,
	"banner_from" timestamp with time zone,
	"banner_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcement_targets_announcement_id_workspace_id_pk" PRIMARY KEY("announcement_id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "cancelled_by" uuid;--> statement-breakpoint
ALTER TABLE "announcement_dismissals" ADD CONSTRAINT "announcement_dismissals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_dismissals" ADD CONSTRAINT "announcement_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_dismissals" ADD CONSTRAINT "announcement_dismissals_target_fk" FOREIGN KEY ("announcement_id","workspace_id") REFERENCES "public"."announcement_targets"("announcement_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_targets" ADD CONSTRAINT "announcement_targets_announcement_id_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_targets" ADD CONSTRAINT "announcement_targets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "announcement_targets_workspace_idx" ON "announcement_targets" USING btree ("workspace_id","banner_from");--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_cancelled_by_staff_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "announcements_due_idx" ON "announcements" USING btree ("scheduled_at") WHERE "announcements"."sent_at" IS NULL AND "announcements"."cancelled_at" IS NULL;--> statement-breakpoint

-- O24: ลูกค้าอ่านแบนเนอร์ประกาศของ Workspace ตัวเอง (เฉพาะ Owner / Admin และเฉพาะที่ส่งแล้ว) · ตาราง announcements ยังเป็นของทีม Friday อย่างเดียว
ALTER TABLE public.announcement_targets ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON public.announcement_targets FROM friday_app;--> statement-breakpoint
GRANT SELECT ON public.announcement_targets TO friday_app;--> statement-breakpoint
CREATE POLICY banner_read ON public.announcement_targets FOR SELECT TO friday_app
  USING (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_ws_admin()) AND banner_from IS NOT NULL);--> statement-breakpoint

-- ปิดแบนเนอร์ต่อคน: อ่าน / เพิ่มได้เฉพาะแถวของตัวเอง · ไม่มีแก้หรือลบ
ALTER TABLE public.announcement_dismissals ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON public.announcement_dismissals FROM friday_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.announcement_dismissals TO friday_app;--> statement-breakpoint
CREATE POLICY own_dismissals ON public.announcement_dismissals TO friday_app
  USING (workspace_id = (SELECT app.workspace_id()) AND user_id = (SELECT app.user_id()) AND (SELECT app.is_member()))
  WITH CHECK (workspace_id = (SELECT app.workspace_id()) AND user_id = (SELECT app.user_id()) AND (SELECT app.is_member()));