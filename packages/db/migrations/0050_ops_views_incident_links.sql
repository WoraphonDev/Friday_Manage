CREATE TABLE "ops_saved_views" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_id" uuid NOT NULL,
	"page" text NOT NULL,
	"name" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"roles" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_saved_views_page_valid" CHECK ("ops_saved_views"."page" IN ('workspaces', 'tickets', 'overdue', 'users', 'privacy', 'deliveries', 'invoices'))
);
--> statement-breakpoint
CREATE TABLE "ops_view_prefs" (
	"staff_id" uuid NOT NULL,
	"view_id" uuid NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	CONSTRAINT "ops_view_prefs_staff_id_view_id_pk" PRIMARY KEY("staff_id","view_id")
);
--> statement-breakpoint
CREATE TABLE "support_ticket_incidents" (
	"ticket_id" uuid PRIMARY KEY NOT NULL,
	"incident_id" uuid NOT NULL,
	"linked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ops_saved_views" ADD CONSTRAINT "ops_saved_views_owner_id_staff_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."staff_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_view_prefs" ADD CONSTRAINT "ops_view_prefs_staff_id_staff_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_view_prefs" ADD CONSTRAINT "ops_view_prefs_view_id_ops_saved_views_id_fk" FOREIGN KEY ("view_id") REFERENCES "public"."ops_saved_views"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_incidents" ADD CONSTRAINT "support_ticket_incidents_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_incidents" ADD CONSTRAINT "support_ticket_incidents_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_incidents" ADD CONSTRAINT "support_ticket_incidents_linked_by_staff_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ops_saved_views_page_idx" ON "ops_saved_views" USING btree ("page");--> statement-breakpoint
CREATE INDEX "support_ticket_incidents_incident_idx" ON "support_ticket_incidents" USING btree ("incident_id");--> statement-breakpoint
-- ใช้เฉพาะทีม Friday (ops-api) · ลูกค้าไม่เห็น · ปิด friday_app แบบ 0048 / 0049
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ops_saved_views', 'ops_view_prefs', 'support_ticket_incidents'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM friday_app', t);
    EXECUTE format('CREATE POLICY ops_only ON public.%I TO friday_app USING (false) WITH CHECK (false)', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TRIGGER touch BEFORE UPDATE ON public.ops_saved_views FOR EACH ROW EXECUTE FUNCTION app.touch();
