CREATE TABLE "customer_account_files" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_account_workspaces" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"tax_ids" text[] DEFAULT '{}' NOT NULL,
	"manager_id" uuid,
	"kind" text DEFAULT 'standard' NOT NULL,
	"contacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"contract_start" date,
	"contract_end" date,
	"contract_value" bigint,
	"contract_seats" integer,
	"contract_sla" jsonb,
	"renewal_reminded" smallint,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_accounts_kind_valid" CHECK ("customer_accounts"."kind" IN ('standard', 'enterprise')),
	CONSTRAINT "customer_accounts_contract_range" CHECK ("customer_accounts"."contract_end" IS NULL OR "customer_accounts"."contract_start" IS NULL OR "customer_accounts"."contract_end" >= "customer_accounts"."contract_start")
);
--> statement-breakpoint
ALTER TABLE "customer_account_files" ADD CONSTRAINT "customer_account_files_account_id_customer_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_files" ADD CONSTRAINT "customer_account_files_uploaded_by_staff_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_workspaces" ADD CONSTRAINT "customer_account_workspaces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_workspaces" ADD CONSTRAINT "customer_account_workspaces_account_id_customer_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_workspaces" ADD CONSTRAINT "customer_account_workspaces_added_by_staff_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_manager_id_staff_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_account_workspaces_account_idx" ON "customer_account_workspaces" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "customer_accounts_contract_end_idx" ON "customer_accounts" USING btree ("contract_end");--> statement-breakpoint
-- ใช้เฉพาะทีม Friday (ops-api) · API ลูกค้าอ่านผ่าน SYSTEM_DB เฉพาะ SLA ตามสัญญาตอนเปิด Ticket · ปิด friday_app แบบ 0048–0050
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customer_accounts', 'customer_account_workspaces', 'customer_account_files'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM friday_app', t);
    EXECUTE format('CREATE POLICY ops_only ON public.%I TO friday_app USING (false) WITH CHECK (false)', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TRIGGER touch BEFORE UPDATE ON public.customer_accounts FOR EACH ROW EXECUTE FUNCTION app.touch();
