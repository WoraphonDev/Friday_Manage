CREATE TABLE "bank_statement_imports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"bank" text NOT NULL,
	"account_no" text NOT NULL,
	"file_name" text NOT NULL,
	"file_sha256" text NOT NULL,
	"period_from" date,
	"period_to" date,
	"deposits" integer DEFAULT 0 NOT NULL,
	"withdrawals" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"matched" integer DEFAULT 0 NOT NULL,
	"reconciled" integer DEFAULT 0 NOT NULL,
	"review" integer DEFAULT 0 NOT NULL,
	"ignored" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"import_id" uuid NOT NULL,
	"txn_at" timestamp with time zone NOT NULL,
	"amount" bigint NOT NULL,
	"balance" bigint,
	"description" text,
	"channel" text,
	"fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"workspace_id" uuid,
	"invoice_id" uuid,
	"payment_id" uuid,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_lines_status_valid" CHECK ("bank_statement_lines"."status" IN ('matched', 'reconciled', 'review', 'ignored')),
	CONSTRAINT "bank_statement_lines_amount_positive" CHECK ("bank_statement_lines"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_import_id_bank_statement_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."bank_statement_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_resolved_by_staff_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_statement_imports_created_idx" ON "bank_statement_imports" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_lines_fingerprint_key" ON "bank_statement_lines" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "bank_statement_lines_status_idx" ON "bank_statement_lines" USING btree ("status","txn_at");--> statement-breakpoint
CREATE INDEX "bank_statement_lines_payment_idx" ON "bank_statement_lines" USING btree ("payment_id");--> statement-breakpoint
-- ใช้เฉพาะทีม Friday (ops-api) · ปิด friday_app แบบ 0051 / 0061 (เลขบัญชีและรายการเงินของบริษัท)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_statement_imports', 'bank_statement_lines'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM friday_app', t);
    EXECUTE format('CREATE POLICY ops_only ON public.%I TO friday_app USING (false) WITH CHECK (false)', t);
  END LOOP;
END $$;
