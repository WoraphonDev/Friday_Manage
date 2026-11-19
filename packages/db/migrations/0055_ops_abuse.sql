CREATE TABLE "abuse_blocks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"label" text,
	"reason" text NOT NULL,
	"case_id" uuid,
	"expires_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	CONSTRAINT "abuse_blocks_kind_valid" CHECK ("abuse_blocks"."kind" IN ('email_domain', 'ip', 'workspace_slug', 'api_token')),
	CONSTRAINT "abuse_blocks_ip_valid" CHECK ("abuse_blocks"."kind" <> 'ip' OR "abuse_blocks"."value"::inet IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "abuse_cases" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "abuse_cases_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"label" text NOT NULL,
	"workspace_ids" uuid[] DEFAULT '{}' NOT NULL,
	"user_ids" uuid[] DEFAULT '{}' NOT NULL,
	"ip" text,
	"score" smallint NOT NULL,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"auto_suspended_at" timestamp with time zone,
	"suspended_ids" uuid[] DEFAULT '{}' NOT NULL,
	"reminded_at" timestamp with time zone,
	"outcome" text,
	"reason" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "abuse_cases_number_unique" UNIQUE("number"),
	CONSTRAINT "abuse_cases_kind_valid" CHECK ("abuse_cases"."kind" IN ('fake_signup', 'invite_spam', 'api_abuse', 'payment')),
	CONSTRAINT "abuse_cases_status_valid" CHECK ("abuse_cases"."status" IN ('open', 'auto_suspended', 'closed')),
	CONSTRAINT "abuse_cases_outcome_valid" CHECK ("abuse_cases"."outcome" IS NULL OR "abuse_cases"."outcome" IN ('dismissed', 'verify_identity', 'suspended', 'blocked')),
	CONSTRAINT "abuse_cases_closed" CHECK (("abuse_cases"."status" = 'closed') = ("abuse_cases"."outcome" IS NOT NULL AND "abuse_cases"."decided_at" IS NOT NULL)),
	CONSTRAINT "abuse_cases_score" CHECK ("abuse_cases"."score" BETWEEN 0 AND 999)
);
--> statement-breakpoint
ALTER TABLE "signup_attributions" ADD COLUMN "signup_ip" text;--> statement-breakpoint
ALTER TABLE "abuse_blocks" ADD CONSTRAINT "abuse_blocks_case_id_abuse_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."abuse_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abuse_blocks" ADD CONSTRAINT "abuse_blocks_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abuse_blocks" ADD CONSTRAINT "abuse_blocks_removed_by_staff_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abuse_cases" ADD CONSTRAINT "abuse_cases_decided_by_staff_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "abuse_blocks_active_key" ON "abuse_blocks" USING btree ("kind",lower("value")) WHERE "abuse_blocks"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "abuse_blocks_created_idx" ON "abuse_blocks" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "abuse_cases_open_subject_key" ON "abuse_cases" USING btree ("subject") WHERE "abuse_cases"."status" <> 'closed';--> statement-breakpoint
CREATE INDEX "abuse_cases_status_idx" ON "abuse_cases" USING btree ("status","score");--> statement-breakpoint
CREATE INDEX "abuse_cases_decided_idx" ON "abuse_cases" USING btree ("decided_at");--> statement-breakpoint
CREATE INDEX "signup_attributions_ip_idx" ON "signup_attributions" USING btree ("signup_ip","created_at") WHERE "signup_attributions"."signup_ip" IS NOT NULL;--> statement-breakpoint
-- ใช้เฉพาะทีม Friday (ops-api) · API ลูกค้าอ่าน abuse_blocks ผ่าน SYSTEM_DB ตอนสมัคร / สร้าง Workspace เท่านั้น · ปิด friday_app แบบ 0051
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['abuse_cases', 'abuse_blocks'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM friday_app', t);
    EXECUTE format('CREATE POLICY ops_only ON public.%I TO friday_app USING (false) WITH CHECK (false)', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TRIGGER touch BEFORE UPDATE ON public.abuse_cases FOR EACH ROW EXECUTE FUNCTION app.touch();
