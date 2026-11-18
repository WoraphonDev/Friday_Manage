CREATE TABLE "ops_presence" (
	"staff_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_presence_staff_id_target_type_target_id_pk" PRIMARY KEY("staff_id","target_type","target_id"),
	CONSTRAINT "ops_presence_type_valid" CHECK ("ops_presence"."target_type" IN ('ticket', 'payment', 'approval', 'privacy')),
	CONSTRAINT "ops_presence_mode_valid" CHECK ("ops_presence"."mode" IN ('viewing', 'typing'))
);
--> statement-breakpoint
ALTER TABLE "ops_presence" ADD CONSTRAINT "ops_presence_staff_id_staff_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ops_presence_target_idx" ON "ops_presence" USING btree ("target_type","target_id");--> statement-breakpoint
-- ใช้เฉพาะทีม Friday (ops-api) · ลูกค้าไม่เห็น · ปิด friday_app แบบ 0048
ALTER TABLE public.ops_presence ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.ops_presence FROM friday_app;
--> statement-breakpoint
CREATE POLICY ops_only ON public.ops_presence TO friday_app USING (false) WITH CHECK (false);
