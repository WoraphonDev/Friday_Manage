CREATE TABLE "coupon_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"coupon_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"cycles_total" integer,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupon_redemptions_workspace_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "coupon_redemptions_workspace_coupon_key" UNIQUE("workspace_id","coupon_id"),
	CONSTRAINT "coupon_redemptions_status_valid" CHECK ("coupon_redemptions"."status" IN ('pending', 'active', 'ended'))
);
--> statement-breakpoint
CREATE TABLE "coupon_uses" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"redemption_id" uuid NOT NULL,
	"coupon_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "coupon_uses_amount_nonnegative" CHECK ("coupon_uses"."amount" >= 0),
	CONSTRAINT "coupon_uses_status_valid" CHECK ("coupon_uses"."status" IN ('pending', 'paid'))
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code" text NOT NULL,
	"description" text,
	"kind" text NOT NULL,
	"value" integer NOT NULL,
	"duration" text NOT NULL,
	"duration_cycles" integer,
	"plan_codes" text[] NOT NULL,
	"max_redemptions" integer,
	"expires_on" date,
	"new_customers_only" boolean DEFAULT false NOT NULL,
	"stackable" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"activated_at" timestamp with time zone,
	"activated_by" uuid,
	"disabled_at" timestamp with time zone,
	"disabled_by" uuid,
	"disable_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupons_code_unique" UNIQUE("code"),
	CONSTRAINT "coupons_code_format" CHECK ("coupons"."code" ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'),
	CONSTRAINT "coupons_kind_valid" CHECK ("coupons"."kind" IN ('percent', 'amount', 'free_months')),
	CONSTRAINT "coupons_value_valid" CHECK ("coupons"."value" > 0 AND ("coupons"."kind" <> 'percent' OR "coupons"."value" <= 100) AND ("coupons"."kind" <> 'free_months' OR "coupons"."value" <= 24)),
	CONSTRAINT "coupons_duration_valid" CHECK ("coupons"."duration" IN ('once', 'repeating', 'forever') AND ("coupons"."duration" = 'repeating') = ("coupons"."duration_cycles" IS NOT NULL) AND ("coupons"."duration_cycles" IS NULL OR "coupons"."duration_cycles" BETWEEN 1 AND 36)),
	CONSTRAINT "coupons_free_months_once" CHECK ("coupons"."kind" <> 'free_months' OR ("coupons"."duration" = 'once' AND NOT "coupons"."stackable")),
	CONSTRAINT "coupons_plans_present" CHECK (cardinality("coupons"."plan_codes") > 0),
	CONSTRAINT "coupons_max_positive" CHECK ("coupons"."max_redemptions" IS NULL OR "coupons"."max_redemptions" > 0),
	CONSTRAINT "coupons_status_valid" CHECK ("coupons"."status" IN ('draft', 'active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "plan_price_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"plan_code" text NOT NULL,
	"version" integer NOT NULL,
	"display_name" text,
	"monthly_satang" bigint,
	"yearly_satang" bigint,
	"listed" boolean DEFAULT true NOT NULL,
	"open_for_signup" boolean DEFAULT true NOT NULL,
	"existing_policy" text DEFAULT 'grandfather' NOT NULL,
	"existing_from" timestamp with time zone,
	"effective_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"approved_by" uuid,
	"approval_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_price_versions_plan_version_key" UNIQUE("plan_code","version"),
	CONSTRAINT "plan_price_versions_version_positive" CHECK ("plan_price_versions"."version" > 0),
	CONSTRAINT "plan_price_versions_prices_nonnegative" CHECK (("plan_price_versions"."monthly_satang" IS NULL OR "plan_price_versions"."monthly_satang" >= 0) AND ("plan_price_versions"."yearly_satang" IS NULL OR "plan_price_versions"."yearly_satang" >= 0)),
	CONSTRAINT "plan_price_versions_policy_valid" CHECK ("plan_price_versions"."existing_policy" IN ('grandfather', 'next_cycle') AND ("plan_price_versions"."existing_policy" = 'grandfather' OR "plan_price_versions"."existing_from" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "discount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "listed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "open_for_signup" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "price_version_id" uuid;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_uses" ADD CONSTRAINT "coupon_uses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_uses" ADD CONSTRAINT "coupon_uses_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_uses" ADD CONSTRAINT "coupon_uses_redemption_fk" FOREIGN KEY ("workspace_id","redemption_id") REFERENCES "public"."coupon_redemptions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_uses" ADD CONSTRAINT "coupon_uses_invoice_fk" FOREIGN KEY ("workspace_id","invoice_id") REFERENCES "public"."invoices"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_activated_by_staff_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_disabled_by_staff_users_id_fk" FOREIGN KEY ("disabled_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_price_versions" ADD CONSTRAINT "plan_price_versions_plan_code_plans_code_fk" FOREIGN KEY ("plan_code") REFERENCES "public"."plans"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_price_versions" ADD CONSTRAINT "plan_price_versions_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_price_versions" ADD CONSTRAINT "plan_price_versions_approved_by_staff_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_price_versions" ADD CONSTRAINT "plan_price_versions_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coupon_redemptions_coupon_idx" ON "coupon_redemptions" USING btree ("coupon_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "coupon_uses_invoice_redemption_key" ON "coupon_uses" USING btree ("invoice_id","redemption_id");--> statement-breakpoint
CREATE INDEX "coupon_uses_coupon_idx" ON "coupon_uses" USING btree ("coupon_id","status");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_discount_nonnegative" CHECK ("invoices"."discount" >= 0);--> statement-breakpoint

-- O20: เวอร์ชันราคาและคูปองเป็นของทีม Friday อย่างเดียว · API ลูกค้าอ่านผ่าน SYSTEM_DB ตอนคิดราคา / ตรวจโค้ด
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['plan_price_versions', 'coupons'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM friday_app', t);
    EXECUTE format('CREATE POLICY ops_only ON public.%I TO friday_app USING (false) WITH CHECK (false)', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- เวอร์ชันราคาเป็นประวัติ: แก้หรือลบไม่ได้ (แก้ราคา = สร้างเวอร์ชันใหม่)
REVOKE UPDATE, DELETE, TRUNCATE ON public.plan_price_versions FROM friday_system;
--> statement-breakpoint

-- การใช้คูปองของ Workspace: Owner / Admin (ผู้ชำระเงิน) อ่านและบันทึกตอน checkout ได้เฉพาะของ Workspace ตัวเอง · ไม่มีแก้หรือลบ
-- (นับรอบที่ใช้ไปตอนรับเงินผ่าน SYSTEM_DB / ops-api)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['coupon_redemptions', 'coupon_uses'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM friday_app', t);
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO friday_app', t);
    EXECUTE format(
      'CREATE POLICY billing_admin ON public.%I TO friday_app
        USING (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_ws_admin()))
        WITH CHECK (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_ws_admin()))', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TRIGGER touch BEFORE UPDATE ON public.coupons FOR EACH ROW EXECUTE FUNCTION app.touch();
--> statement-breakpoint
CREATE TRIGGER touch BEFORE UPDATE ON public.coupon_redemptions FOR EACH ROW EXECUTE FUNCTION app.touch();
--> statement-breakpoint

-- เวอร์ชัน 1 = ราคาที่ใช้อยู่ก่อนมีหน้านี้ · ลูกค้าเดิมทุกรายผูกกับเวอร์ชัน 1 (ราคาเดิมจนกว่าจะเลือกย้าย)
INSERT INTO public.plan_price_versions (plan_code, version, monthly_satang, yearly_satang, effective_at, reason)
SELECT code, 1, price_monthly_satang, price_yearly_satang, '2026-01-01T00:00:00+07:00', 'เวอร์ชันเริ่มต้น (ราคาเดิม)' FROM public.plans
ON CONFLICT (plan_code, version) DO NOTHING;
--> statement-breakpoint
UPDATE public.subscriptions s SET price_version_id = v.id
FROM public.plans p JOIN public.plan_price_versions v ON v.plan_code = p.code AND v.version = 1
WHERE s.plan_id = p.id AND s.price_version_id IS NULL;