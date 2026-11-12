ALTER TABLE "projects" ADD COLUMN "qa_buffer_days" smallint DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "qa_end" date;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_qa_buffer_days" CHECK ("projects"."qa_buffer_days" between 0 and 30);