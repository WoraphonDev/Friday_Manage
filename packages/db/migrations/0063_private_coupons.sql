ALTER TABLE "coupons" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coupons_workspace_idx" ON "coupons" USING btree ("workspace_id") WHERE "coupons"."workspace_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_private_single" CHECK ("coupons"."workspace_id" IS NULL OR "coupons"."max_redemptions" = 1);