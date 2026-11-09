CREATE TABLE "data_breaches" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "data_breaches_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"discovered_at" timestamp with time zone NOT NULL,
	"owner_id" uuid NOT NULL,
	"description" text NOT NULL,
	"data_types" text[] DEFAULT '{}' NOT NULL,
	"affected_count" integer,
	"workspace_ids" uuid[] DEFAULT '{}' NOT NULL,
	"risk" text DEFAULT 'medium' NOT NULL,
	"containment" text,
	"contained_at" timestamp with time zone,
	"assessment" text,
	"pdpc_notified_at" timestamp with time zone,
	"subjects_notified_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_breaches_number_unique" UNIQUE("number"),
	CONSTRAINT "data_breaches_risk_valid" CHECK ("data_breaches"."risk" IN ('low', 'medium', 'high')),
	CONSTRAINT "data_breaches_affected" CHECK ("data_breaches"."affected_count" IS NULL OR "data_breaches"."affected_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "privacy_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "privacy_requests_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"request_type" text NOT NULL,
	"requester_email" text NOT NULL,
	"user_id" uuid,
	"workspace_ids" uuid[] DEFAULT '{}' NOT NULL,
	"details" text,
	"received_at" timestamp with time zone NOT NULL,
	"due_date" date NOT NULL,
	"identity" text DEFAULT 'unverified' NOT NULL,
	"step" smallint DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"rejection_reason" text,
	"handled_by" uuid,
	"approval_request_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_requests_number_unique" UNIQUE("number"),
	CONSTRAINT "privacy_requests_type_valid" CHECK ("privacy_requests"."request_type" IN ('access', 'export', 'rectify', 'erase', 'object', 'restrict')),
	CONSTRAINT "privacy_requests_identity_valid" CHECK ("privacy_requests"."identity" IN ('unverified', 'email_match', 'link_confirmed')),
	CONSTRAINT "privacy_requests_status_valid" CHECK ("privacy_requests"."status" IN ('open', 'completed', 'rejected')),
	CONSTRAINT "privacy_requests_step" CHECK ("privacy_requests"."step" BETWEEN 1 AND 5),
	CONSTRAINT "privacy_requests_rejected" CHECK (("privacy_requests"."status" = 'rejected') = ("privacy_requests"."rejection_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "legal_documents" ADD COLUMN "requires_acceptance" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "legal_documents" ADD COLUMN "created_by_staff" uuid;--> statement-breakpoint
ALTER TABLE "data_breaches" ADD CONSTRAINT "data_breaches_owner_id_staff_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_handled_by_staff_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_breaches_open_idx" ON "data_breaches" USING btree ("closed_at","discovered_at");--> statement-breakpoint
CREATE INDEX "privacy_requests_status_idx" ON "privacy_requests" USING btree ("status","due_date");--> statement-breakpoint
-- O05: คำขอ PDPA และเหตุละเมิดข้อมูลใช้เฉพาะทีม Friday (ops-api ผ่าน friday_worker) · ลูกค้าอ่าน/เขียนไม่ได้เลย
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['privacy_requests', 'data_breaches'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM friday_app', t);
    EXECUTE format('CREATE POLICY ops_only ON public.%I TO friday_app USING (false) WITH CHECK (false)', t);
    EXECUTE format('CREATE TRIGGER touch BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch()', t);
  END LOOP;
END $$;
