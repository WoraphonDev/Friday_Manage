CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"number" text NOT NULL,
	"account_id" uuid NOT NULL,
	"lead_id" uuid,
	"workspace_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"plan_code" text DEFAULT 'enterprise' NOT NULL,
	"seats" integer NOT NULL,
	"months" smallint NOT NULL,
	"price_per_seat_satang" bigint NOT NULL,
	"list_per_seat_satang" bigint NOT NULL,
	"subtotal_satang" bigint NOT NULL,
	"vat_satang" bigint NOT NULL,
	"total_satang" bigint NOT NULL,
	"entitlements" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sla" jsonb,
	"contract_start" date,
	"valid_until" date NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"approval_request_id" uuid,
	"token_hash" text,
	"sent_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"acceptance" jsonb,
	"change_request" text,
	"setup" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotes_number_unique" UNIQUE("number"),
	CONSTRAINT "quotes_tokenHash_unique" UNIQUE("token_hash"),
	CONSTRAINT "quotes_status_valid" CHECK ("quotes"."status" IN ('draft', 'sent', 'accepted', 'declined', 'expired')),
	CONSTRAINT "quotes_months_valid" CHECK ("quotes"."months" IN (12, 24, 36)),
	CONSTRAINT "quotes_amounts" CHECK ("quotes"."seats" > 0 AND "quotes"."price_per_seat_satang" >= 0 AND "quotes"."total_satang" = "quotes"."subtotal_satang" + "quotes"."vat_satang"),
	CONSTRAINT "quotes_accepted" CHECK (("quotes"."status" = 'accepted') = ("quotes"."accepted_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_account_id_customer_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_approved_by_staff_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quotes_status_idx" ON "quotes" USING btree ("status","valid_until");--> statement-breakpoint
CREATE INDEX "quotes_account_idx" ON "quotes" USING btree ("account_id");--> statement-breakpoint
-- ใช้เฉพาะทีม Friday · API ลูกค้าอ่าน / ตอบรับผ่าน SYSTEM_DB ด้วย token ของลิงก์เท่านั้น · ปิด friday_app แบบ 0051
ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.quotes FROM friday_app;
--> statement-breakpoint
CREATE POLICY ops_only ON public.quotes TO friday_app USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE TRIGGER touch BEFORE UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION app.touch();
