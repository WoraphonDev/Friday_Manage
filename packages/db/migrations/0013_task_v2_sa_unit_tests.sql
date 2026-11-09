CREATE TYPE "public"."test_kind" AS ENUM('qa', 'unit');--> statement-breakpoint
DROP INDEX "test_runs_issue_run_key";--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "sa_id" uuid;--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "kind" "test_kind" DEFAULT 'qa' NOT NULL;--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "coverage_pct" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_sa_id_users_id_fk" FOREIGN KEY ("sa_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "test_runs_issue_kind_run_key" ON "test_runs" USING btree ("issue_id","kind","run_no");--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_coverage_range" CHECK ("test_runs"."coverage_pct" between 0 and 100);--> statement-breakpoint
-- QA / Reviewer รวมเป็นช่องเดียว (ผู้ใช้ตัดสิน 2026-11-08): งานที่มี Tester แต่ยังไม่มี Reviewer ย้ายชื่อ Tester มาเป็น Reviewer
UPDATE "issues" SET "reviewer_id" = "tester_id" WHERE "reviewer_id" IS NULL AND "tester_id" IS NOT NULL;
