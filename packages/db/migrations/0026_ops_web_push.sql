CREATE TABLE "staff_push_notices" (
	"key" text PRIMARY KEY NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"staff_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"last_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staff_push_subscriptions" ADD CONSTRAINT "staff_push_subscriptions_staff_id_staff_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_push_subscriptions_endpoint_key" ON "staff_push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "staff_push_subscriptions_staff_idx" ON "staff_push_subscriptions" USING btree ("staff_id");--> statement-breakpoint

-- O25: ใช้เฉพาะทีม Friday (ops-api) · แอปของลูกค้าแตะไม่ได้
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff_push_subscriptions', 'staff_push_notices'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM friday_app', t);
    EXECUTE format('CREATE POLICY ops_only ON public.%I TO friday_app USING (false) WITH CHECK (false)', t);
  END LOOP;
END $$;
