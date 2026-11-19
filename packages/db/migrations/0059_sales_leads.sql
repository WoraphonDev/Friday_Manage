CREATE TABLE "lead_notes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lead_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"next_action" text,
	"next_at" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_notes_kind_valid" CHECK ("lead_notes"."kind" IN ('call', 'email', 'meeting', 'note', 'system'))
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "leads_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"company" text NOT NULL,
	"contact_name" text,
	"contact_title" text,
	"email" text,
	"phone" text,
	"team_size" integer,
	"needs" text[] DEFAULT '{}' NOT NULL,
	"message" text,
	"source" text NOT NULL,
	"stage" text DEFAULT 'new' NOT NULL,
	"lost_reason" text,
	"value_satang" bigint,
	"seats" integer,
	"owner_id" uuid,
	"next_action" text,
	"next_at" date,
	"workspace_id" uuid,
	"account_id" uuid,
	"consent_at" timestamp with time zone,
	"ip" text,
	"contacted_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_number_unique" UNIQUE("number"),
	CONSTRAINT "leads_source_valid" CHECK ("leads"."source" IN ('form', 'trial', 'manual')),
	CONSTRAINT "leads_stage_valid" CHECK ("leads"."stage" IN ('new', 'contacted', 'demo', 'proposal', 'won', 'lost')),
	CONSTRAINT "leads_lost_reason" CHECK (("leads"."stage" = 'lost') = ("leads"."lost_reason" IS NOT NULL) AND ("leads"."lost_reason" IS NULL OR "leads"."lost_reason" IN ('price', 'missing_feature', 'competitor', 'no_budget', 'silent'))),
	CONSTRAINT "leads_closed" CHECK (("leads"."stage" IN ('won', 'lost')) = ("leads"."closed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_id_staff_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_account_id_customer_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_notes_lead_idx" ON "lead_notes" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "leads_stage_idx" ON "leads" USING btree ("stage","next_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_workspace_key" ON "leads" USING btree ("workspace_id") WHERE "leads"."workspace_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "leads_email_idx" ON "leads" USING btree (lower("email"));--> statement-breakpoint
-- ใช้เฉพาะทีม Friday · API ลูกค้าเขียน leads ผ่าน SYSTEM_DB จากฟอร์มติดต่อฝ่ายขาย (ยังไม่มี Workspace) · ปิด friday_app แบบ 0051
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['leads', 'lead_notes'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM friday_app', t);
    EXECUTE format('CREATE POLICY ops_only ON public.%I TO friday_app USING (false) WITH CHECK (false)', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TRIGGER touch BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION app.touch();
