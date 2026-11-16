CREATE TABLE "quotations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"number" text NOT NULL,
	"plan" text NOT NULL,
	"cycle" "billing_cycle" NOT NULL,
	"wht" boolean DEFAULT false NOT NULL,
	"coupon" text,
	"subtotal" bigint NOT NULL,
	"discount" bigint DEFAULT 0 NOT NULL,
	"vat" bigint NOT NULL,
	"total" bigint NOT NULL,
	"wht_amount" bigint DEFAULT 0 NOT NULL,
	"amount_due" bigint NOT NULL,
	"valid_until" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotations_number_unique" UNIQUE("number"),
	CONSTRAINT "quotations_workspace_id_key" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "debit_notes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"number" text NOT NULL,
	"amount_satang" bigint NOT NULL,
	"vat_satang" bigint DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"charge_invoice_id" uuid,
	"created_by_staff" uuid,
	"approval_request_id" uuid,
	"issued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "debit_notes_number_unique" UNIQUE("number"),
	CONSTRAINT "debit_notes_workspace_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "debit_notes_status_valid" CHECK ("debit_notes"."status" IN ('issued', 'sent')),
	CONSTRAINT "debit_notes_amounts" CHECK ("debit_notes"."amount_satang" > 0 AND "debit_notes"."vat_satang" >= 0)
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD COLUMN "issued_on" date;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD COLUMN "replaces_id" uuid;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_created_by_staff_staff_users_id_fk" FOREIGN KEY ("created_by_staff") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_invoice_fk" FOREIGN KEY ("workspace_id","invoice_id") REFERENCES "public"."invoices"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quotations_workspace_idx" ON "quotations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "debit_notes_invoice_idx" ON "debit_notes" USING btree ("invoice_id");