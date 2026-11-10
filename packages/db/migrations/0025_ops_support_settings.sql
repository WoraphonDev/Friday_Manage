CREATE TABLE "support_account_managers" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"staff_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_agents" (
	"staff_id" uuid PRIMARY KEY NOT NULL,
	"groups" text[] DEFAULT '{}' NOT NULL,
	"cap" smallint,
	"presence" text DEFAULT 'online' NOT NULL,
	"presence_note" text,
	"presence_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_agents_groups_valid" CHECK ("support_agents"."groups" <@ ARRAY['l1', 'l2', 'fin', 'lead']::text[]),
	CONSTRAINT "support_agents_presence_valid" CHECK ("support_agents"."presence" IN ('online', 'busy', 'offline', 'leave')),
	CONSTRAINT "support_agents_cap" CHECK ("support_agents"."cap" IS NULL OR "support_agents"."cap" BETWEEN 1 AND 99)
);
--> statement-breakpoint
CREATE TABLE "support_canned_replies" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"tag" text,
	"uses" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"position" integer NOT NULL,
	"name" text,
	"plans" text[] DEFAULT '{}' NOT NULL,
	"categories" text[] DEFAULT '{}' NOT NULL,
	"target" text NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_rules_target_valid" CHECK ("support_rules"."target" IN ('l1', 'l2', 'fin', 'acct', 'all')),
	CONSTRAINT "support_rules_priority_valid" CHECK ("support_rules"."priority" IN ('low', 'normal', 'high', 'urgent'))
);
--> statement-breakpoint
CREATE TABLE "support_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"round_robin_last" uuid,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_settings_singleton" CHECK ("support_settings"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "rule_id" uuid;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "sla_alerts" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "support_account_managers" ADD CONSTRAINT "support_account_managers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_account_managers" ADD CONSTRAINT "support_account_managers_staff_id_staff_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_agents" ADD CONSTRAINT "support_agents_staff_id_staff_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_canned_replies" ADD CONSTRAINT "support_canned_replies_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_canned_replies" ADD CONSTRAINT "support_canned_replies_updated_by_staff_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_rules" ADD CONSTRAINT "support_rules_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_settings" ADD CONSTRAINT "support_settings_round_robin_last_staff_users_id_fk" FOREIGN KEY ("round_robin_last") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_settings" ADD CONSTRAINT "support_settings_updated_by_staff_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_account_managers_staff_idx" ON "support_account_managers" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "support_rules_position_idx" ON "support_rules" USING btree ("position");--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_rule_id_support_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."support_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- O22: ใช้เฉพาะทีม Friday (ops-api) · แอปของลูกค้าแตะไม่ได้
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['support_settings', 'support_rules', 'support_agents', 'support_account_managers', 'support_canned_replies'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM friday_app', t);
    EXECUTE format('CREATE POLICY ops_only ON public.%I TO friday_app USING (false) WITH CHECK (false)', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TRIGGER touch BEFORE UPDATE ON public.support_settings FOR EACH ROW EXECUTE FUNCTION app.touch();
--> statement-breakpoint
CREATE TRIGGER touch BEFORE UPDATE ON public.support_rules FOR EACH ROW EXECUTE FUNCTION app.touch();
--> statement-breakpoint
CREATE TRIGGER touch BEFORE UPDATE ON public.support_agents FOR EACH ROW EXECUTE FUNCTION app.touch();
--> statement-breakpoint
CREATE TRIGGER touch BEFORE UPDATE ON public.support_canned_replies FOR EACH ROW EXECUTE FUNCTION app.touch();
--> statement-breakpoint
-- ค่าเริ่มต้นอยู่ในโค้ด (config ว่าง = ใช้ค่าเริ่มต้นทั้งหมด)
INSERT INTO public.support_settings (id) VALUES (1);
--> statement-breakpoint
-- กฎตั้งต้นตาม Canvas (SupportSettings) · กลุ่มที่ยังไม่มีสมาชิกจะแจกให้ทุกคนแทน
INSERT INTO public.support_rules (position, plans, categories, target, priority) VALUES
  (1, '{enterprise}', '{}', 'acct', 'high'),
  (2, '{}', '{billing,tax_invoice,payment}', 'fin', 'normal'),
  (3, '{}', '{outage}', 'l2', 'urgent'),
  (4, '{}', '{bug,import,notification,api}', 'l2', 'high'),
  (5, '{}', '{how_to,feature_request}', 'l1', 'normal'),
  (6, '{}', '{}', 'all', 'normal');
