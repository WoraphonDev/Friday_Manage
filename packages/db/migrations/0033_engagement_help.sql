CREATE TABLE "dev_bridge_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"api_base_url" text,
	"workspace_slug" text,
	"project_key" text,
	"token_enc" text,
	"token_hint" text,
	"token_expires_at" timestamp with time zone,
	"webhook_secret_enc" text,
	"mapping" jsonb DEFAULT '{"severityPriority":{"S1":"urgent","S2":"high","S3":"medium","S4":"low"},"releasedStatus":"Released","label":"from-support","issueType":"Bug"}'::jsonb NOT NULL,
	"last_webhook_at" timestamp with time zone,
	"last_test_at" timestamp with time zone,
	"last_test_ok" boolean,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dev_bridge_settings_singleton" CHECK ("dev_bridge_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "dev_issue_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"issue_key" text NOT NULL,
	"issue_id" uuid,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"status_name" text,
	"status_category" text,
	"resolution" text,
	"duplicate_of_key" text,
	"assignee_name" text,
	"sprint_name" text,
	"due_date" date,
	"done_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"release_version" text,
	"synced_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dev_issue_links_issue_key_unique" UNIQUE("issue_key"),
	CONSTRAINT "dev_issue_links_severity_valid" CHECK ("dev_issue_links"."severity" IN ('S1', 'S2', 'S3', 'S4')),
	CONSTRAINT "dev_issue_links_category_valid" CHECK ("dev_issue_links"."status_category" IS NULL OR "dev_issue_links"."status_category" IN ('todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled')),
	CONSTRAINT "dev_issue_links_resolution_valid" CHECK ("dev_issue_links"."resolution" IS NULL OR "dev_issue_links"."resolution" IN ('fixed', 'wont_fix', 'duplicate')),
	CONSTRAINT "dev_issue_links_duplicate" CHECK ("dev_issue_links"."duplicate_of_key" IS NULL OR "dev_issue_links"."resolution" = 'duplicate')
);
--> statement-breakpoint
CREATE TABLE "dev_issue_tickets" (
	"ticket_id" uuid PRIMARY KEY NOT NULL,
	"link_id" uuid NOT NULL,
	"linked_by" uuid,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	"notified_by" uuid,
	"outcome" text,
	CONSTRAINT "dev_issue_tickets_outcome_valid" CHECK ("dev_issue_tickets"."outcome" IS NULL OR "dev_issue_tickets"."outcome" IN ('fixed', 'workaround', 'returned')),
	CONSTRAINT "dev_issue_tickets_notified" CHECK ("dev_issue_tickets"."outcome" IS NULL OR "dev_issue_tickets"."outcome" = 'returned' OR "dev_issue_tickets"."notified_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "help_article_tickets" (
	"article_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"source" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "help_article_tickets_article_id_ticket_id_pk" PRIMARY KEY("article_id","ticket_id"),
	CONSTRAINT "help_article_tickets_source_valid" CHECK ("help_article_tickets"."source" IN ('customer', 'staff', 'created_from'))
);
--> statement-breakpoint
CREATE TABLE "help_article_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"article_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"category_id" uuid,
	"title" text NOT NULL,
	"summary" text,
	"body" text NOT NULL,
	"title_en" text,
	"summary_en" text,
	"body_en" text,
	"visibility" text NOT NULL,
	"app_routes" text[] DEFAULT '{}' NOT NULL,
	"keywords" text,
	"published_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "help_article_views" (
	"article_id" uuid NOT NULL,
	"day" date NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "help_article_views_article_id_day_pk" PRIMARY KEY("article_id","day")
);
--> statement-breakpoint
CREATE TABLE "help_articles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"slug" text NOT NULL,
	"category_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"body" text DEFAULT '' NOT NULL,
	"title_en" text,
	"summary_en" text,
	"body_en" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"app_routes" text[] DEFAULT '{}' NOT NULL,
	"keywords" text,
	"review_at" date,
	"owner_id" uuid,
	"source_ticket_id" uuid,
	"pii_checked_at" timestamp with time zone,
	"pii_checked_by" uuid,
	"draft" jsonb,
	"draft_saved_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"search_text" text GENERATED ALWAYS AS (lower("help_articles"."title" || ' ' || coalesce("help_articles"."summary", '') || ' ' || coalesce("help_articles"."keywords", '') || ' ' || coalesce("help_articles"."title_en", '') || ' ' || coalesce("help_articles"."summary_en", '') || ' ' || "help_articles"."body" || ' ' || coalesce("help_articles"."body_en", ''))) STORED,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "help_articles_slug_unique" UNIQUE("slug"),
	CONSTRAINT "help_articles_slug_format" CHECK ("help_articles"."slug" ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
	CONSTRAINT "help_articles_status_valid" CHECK ("help_articles"."status" IN ('draft', 'published', 'archived')),
	CONSTRAINT "help_articles_visibility_valid" CHECK ("help_articles"."visibility" IN ('public', 'signed_in')),
	CONSTRAINT "help_articles_published" CHECK ("help_articles"."status" <> 'published' OR ("help_articles"."published_at" IS NOT NULL AND "help_articles"."pii_checked_at" IS NOT NULL AND "help_articles"."version" > 0))
);
--> statement-breakpoint
CREATE TABLE "help_categories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"name_en" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "help_categories_slug_unique" UNIQUE("slug"),
	CONSTRAINT "help_categories_slug_format" CHECK ("help_categories"."slug" ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);
--> statement-breakpoint
CREATE TABLE "help_feedback" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"article_id" uuid NOT NULL,
	"helpful" boolean NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "help_feedback_comment_length" CHECK ("help_feedback"."comment" IS NULL OR char_length("help_feedback"."comment") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "help_search_misses" (
	"day" date NOT NULL,
	"query" text NOT NULL,
	"searches" integer DEFAULT 0 NOT NULL,
	"tickets" integer DEFAULT 0 NOT NULL,
	"article_id" uuid,
	CONSTRAINT "help_search_misses_day_query_pk" PRIMARY KEY("day","query")
);
--> statement-breakpoint
CREATE TABLE "help_search_stats" (
	"day" date PRIMARY KEY NOT NULL,
	"searches" integer DEFAULT 0 NOT NULL,
	"misses" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "changelog_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"title_en" text,
	"summary_en" text,
	"body_en" text,
	"media_url" text,
	"media_kind" text,
	"media_alt" text,
	"cta_label" text,
	"cta_label_en" text,
	"cta_path" text,
	"audience" text DEFAULT 'all' NOT NULL,
	"audience_plans" text[] DEFAULT '{}' NOT NULL,
	"audience_flag" text,
	"spotlight" boolean DEFAULT false NOT NULL,
	"show_public" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"display_date" date,
	"published_at" timestamp with time zone,
	"hidden_at" timestamp with time zone,
	"hidden_by" uuid,
	"hide_reason" text,
	"dev_issue_link_id" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "changelog_entries_kind_valid" CHECK ("changelog_entries"."kind" IN ('new', 'improved', 'fixed')),
	CONSTRAINT "changelog_entries_audience_valid" CHECK ("changelog_entries"."audience" IN ('all', 'plans', 'flag', 'admins')),
	CONSTRAINT "changelog_entries_status_valid" CHECK ("changelog_entries"."status" IN ('draft', 'scheduled', 'published', 'hidden')),
	CONSTRAINT "changelog_entries_media_kind_valid" CHECK ("changelog_entries"."media_kind" IS NULL OR "changelog_entries"."media_kind" IN ('image', 'video')),
	CONSTRAINT "changelog_entries_audience_values" CHECK (("changelog_entries"."audience" = 'plans') = (cardinality("changelog_entries"."audience_plans") > 0) AND ("changelog_entries"."audience" = 'flag') = ("changelog_entries"."audience_flag" IS NOT NULL)),
	CONSTRAINT "changelog_entries_summary_length" CHECK (char_length("changelog_entries"."summary") <= 140 AND ("changelog_entries"."summary_en" IS NULL OR char_length("changelog_entries"."summary_en") <= 140)),
	CONSTRAINT "changelog_entries_published_at" CHECK ("changelog_entries"."status" NOT IN ('scheduled', 'published') OR "changelog_entries"."published_at" IS NOT NULL),
	CONSTRAINT "changelog_entries_hidden" CHECK (("changelog_entries"."status" = 'hidden') = ("changelog_entries"."hidden_at" IS NOT NULL) AND ("changelog_entries"."status" <> 'hidden' OR "changelog_entries"."hide_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "changelog_stats" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nps_responses" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid,
	"role" "workspace_role" NOT NULL,
	"plan" text,
	"score" smallint,
	"comment" text,
	"topics" text[] DEFAULT '{}' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"follow_up_status" text DEFAULT 'open' NOT NULL,
	"followed_up_by" uuid,
	"followed_up_at" timestamp with time zone,
	"ticket_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nps_responses_score_range" CHECK ("nps_responses"."score" IS NULL OR "nps_responses"."score" BETWEEN 0 AND 10),
	CONSTRAINT "nps_responses_dismissed" CHECK ("nps_responses"."score" IS NOT NULL OR ("nps_responses"."comment" IS NULL AND cardinality("nps_responses"."topics") = 0)),
	CONSTRAINT "nps_responses_comment_length" CHECK ("nps_responses"."comment" IS NULL OR char_length("nps_responses"."comment") <= 2000),
	CONSTRAINT "nps_responses_follow_up_valid" CHECK ("nps_responses"."follow_up_status" IN ('open', 'done'))
);
--> statement-breakpoint
CREATE TABLE "nps_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"audience" text DEFAULT 'admins' NOT NULL,
	"first_after_days" smallint DEFAULT 30 NOT NULL,
	"repeat_days" smallint DEFAULT 90 NOT NULL,
	"sample_pct" smallint DEFAULT 50 NOT NULL,
	"exclude_trial_days" smallint DEFAULT 14,
	"exclude_ticket_days" smallint DEFAULT 7,
	"exclude_spotlight_day" boolean DEFAULT true NOT NULL,
	"exclude_short_mobile" boolean DEFAULT true NOT NULL,
	"question" text DEFAULT 'คุณจะแนะนำ Friday Manage ให้เพื่อนหรือเพื่อนร่วมงานไหม' NOT NULL,
	"question_en" text,
	"follow_ups" jsonb DEFAULT '{"detractor":"อะไรที่เราควรปรับให้ดีขึ้นที่สุด","passive":"อะไรที่จะทำให้ให้ 10 คะแนน","promoter":"ชอบอะไรที่สุด"}'::jsonb NOT NULL,
	"follow_ups_en" jsonb,
	"topics" text[] DEFAULT '{speed,usability,missing_feature,price,mobile}' NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nps_settings_singleton" CHECK ("nps_settings"."id" = 1),
	CONSTRAINT "nps_settings_audience_valid" CHECK ("nps_settings"."audience" IN ('admins', 'members')),
	CONSTRAINT "nps_settings_days" CHECK ("nps_settings"."first_after_days" >= 0 AND "nps_settings"."repeat_days" >= 1 AND ("nps_settings"."exclude_trial_days" IS NULL OR "nps_settings"."exclude_trial_days" >= 0) AND ("nps_settings"."exclude_ticket_days" IS NULL OR "nps_settings"."exclude_ticket_days" >= 0)),
	CONSTRAINT "nps_settings_sample" CHECK ("nps_settings"."sample_pct" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "onboarding_dismissals" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"hidden_at" timestamp with time zone,
	"never" boolean DEFAULT false NOT NULL,
	"completion_seen_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_dismissals_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "onboarding_followups" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"assignee_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"last_emailed_at" timestamp with time zone,
	"emails_sent" integer DEFAULT 0 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_followups_status_valid" CHECK ("onboarding_followups"."status" IN ('open', 'emailed', 'no_reply', 'replied', 'done'))
);
--> statement-breakpoint
CREATE TABLE "onboarding_progress" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid,
	"version" smallint DEFAULT 1 NOT NULL,
	"step" text NOT NULL,
	"done_at" timestamp with time zone DEFAULT now() NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "onboarding_progress_step_key" UNIQUE NULLS NOT DISTINCT("workspace_id","user_id","version","step")
);
--> statement-breakpoint
CREATE TABLE "user_ui_states" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"whats_new_seen_at" timestamp with time zone,
	"spotlight_seen_ids" uuid[] DEFAULT '{}' NOT NULL,
	"spotlight_seen_at" timestamp with time zone,
	"nps_prompted_at" timestamp with time zone,
	"nps_responded_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dev_bridge_settings" ADD CONSTRAINT "dev_bridge_settings_updated_by_staff_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dev_issue_links" ADD CONSTRAINT "dev_issue_links_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dev_issue_tickets" ADD CONSTRAINT "dev_issue_tickets_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dev_issue_tickets" ADD CONSTRAINT "dev_issue_tickets_link_id_dev_issue_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."dev_issue_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dev_issue_tickets" ADD CONSTRAINT "dev_issue_tickets_linked_by_staff_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dev_issue_tickets" ADD CONSTRAINT "dev_issue_tickets_notified_by_staff_users_id_fk" FOREIGN KEY ("notified_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_article_tickets" ADD CONSTRAINT "help_article_tickets_article_id_help_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."help_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_article_tickets" ADD CONSTRAINT "help_article_tickets_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_article_tickets" ADD CONSTRAINT "help_article_tickets_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_article_versions" ADD CONSTRAINT "help_article_versions_article_id_help_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."help_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_article_versions" ADD CONSTRAINT "help_article_versions_published_by_staff_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_article_views" ADD CONSTRAINT "help_article_views_article_id_help_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."help_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_articles" ADD CONSTRAINT "help_articles_category_id_help_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."help_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_articles" ADD CONSTRAINT "help_articles_owner_id_staff_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_articles" ADD CONSTRAINT "help_articles_source_ticket_id_support_tickets_id_fk" FOREIGN KEY ("source_ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_articles" ADD CONSTRAINT "help_articles_pii_checked_by_staff_users_id_fk" FOREIGN KEY ("pii_checked_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_articles" ADD CONSTRAINT "help_articles_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_articles" ADD CONSTRAINT "help_articles_updated_by_staff_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_feedback" ADD CONSTRAINT "help_feedback_article_id_help_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."help_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_search_misses" ADD CONSTRAINT "help_search_misses_article_id_help_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."help_articles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changelog_entries" ADD CONSTRAINT "changelog_entries_hidden_by_staff_users_id_fk" FOREIGN KEY ("hidden_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changelog_entries" ADD CONSTRAINT "changelog_entries_dev_issue_link_id_dev_issue_links_id_fk" FOREIGN KEY ("dev_issue_link_id") REFERENCES "public"."dev_issue_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changelog_entries" ADD CONSTRAINT "changelog_entries_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changelog_entries" ADD CONSTRAINT "changelog_entries_updated_by_staff_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changelog_stats" ADD CONSTRAINT "changelog_stats_entry_id_changelog_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."changelog_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nps_responses" ADD CONSTRAINT "nps_responses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nps_responses" ADD CONSTRAINT "nps_responses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nps_responses" ADD CONSTRAINT "nps_responses_followed_up_by_staff_users_id_fk" FOREIGN KEY ("followed_up_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nps_responses" ADD CONSTRAINT "nps_responses_ticket_fk" FOREIGN KEY ("workspace_id","ticket_id") REFERENCES "public"."support_tickets"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nps_settings" ADD CONSTRAINT "nps_settings_updated_by_staff_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_dismissals" ADD CONSTRAINT "onboarding_dismissals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_dismissals" ADD CONSTRAINT "onboarding_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_followups" ADD CONSTRAINT "onboarding_followups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_followups" ADD CONSTRAINT "onboarding_followups_assignee_id_staff_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_followups" ADD CONSTRAINT "onboarding_followups_updated_by_staff_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_ui_states" ADD CONSTRAINT "user_ui_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dev_issue_links_status_idx" ON "dev_issue_links" USING btree ("status_category","severity");--> statement-breakpoint
CREATE INDEX "dev_issue_tickets_link_idx" ON "dev_issue_tickets" USING btree ("link_id");--> statement-breakpoint
CREATE INDEX "help_article_tickets_ticket_idx" ON "help_article_tickets" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "help_article_versions_article_version_key" ON "help_article_versions" USING btree ("article_id","version");--> statement-breakpoint
CREATE INDEX "help_articles_category_idx" ON "help_articles" USING btree ("category_id","status");--> statement-breakpoint
CREATE INDEX "help_articles_search_trgm_idx" ON "help_articles" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "help_articles_routes_idx" ON "help_articles" USING gin ("app_routes");--> statement-breakpoint
CREATE INDEX "help_feedback_article_idx" ON "help_feedback" USING btree ("article_id","created_at");--> statement-breakpoint
CREATE INDEX "help_search_misses_query_idx" ON "help_search_misses" USING btree ("query");--> statement-breakpoint
CREATE INDEX "changelog_entries_published_idx" ON "changelog_entries" USING btree ("status","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "changelog_entries_spotlight_key" ON "changelog_entries" USING btree ("spotlight") WHERE "changelog_entries"."spotlight" AND "changelog_entries"."status" IN ('scheduled', 'published');--> statement-breakpoint
CREATE INDEX "nps_responses_workspace_idx" ON "nps_responses" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "nps_responses_created_idx" ON "nps_responses" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "onboarding_followups_assignee_idx" ON "onboarding_followups" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "onboarding_progress_done_idx" ON "onboarding_progress" USING btree ("done_at");--> statement-breakpoint

-- O32: RLS และสิทธิ์ · ตารางใหม่ได้สิทธิ์เริ่มต้นจาก default privileges (0001) จึงถอนออกทั้งหมดก่อน แล้วให้เฉพาะที่ API ลูกค้าใช้จริง
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'changelog_entries', 'changelog_stats', 'user_ui_states', 'nps_settings', 'nps_responses',
    'onboarding_progress', 'onboarding_dismissals', 'onboarding_followups',
    'help_categories', 'help_articles', 'help_article_versions', 'help_feedback', 'help_article_views',
    'help_search_stats', 'help_search_misses', 'help_article_tickets',
    'dev_issue_links', 'dev_issue_tickets', 'dev_bridge_settings'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM friday_app', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- 1. ของทีม Friday อย่างเดียว (ops-api ผ่าน friday_worker) · ยอดนับที่ลูกค้าเพิ่มได้ทำผ่านฟังก์ชันข้อ 4 เท่านั้น
-- Ticket ที่ลูกค้าแนบบทความ (help_article_tickets) A44 เขียนผ่าน SYSTEM_DB พร้อมการสร้าง Ticket เหมือนตาราง support_tickets
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'changelog_stats', 'onboarding_followups', 'help_article_versions', 'help_search_stats', 'help_search_misses',
    'help_article_tickets', 'dev_issue_links', 'dev_issue_tickets', 'dev_bridge_settings'
  ] LOOP
    EXECUTE format('CREATE POLICY ops_only ON public.%I TO friday_app USING (false) WITH CHECK (false)', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- 2. ลูกค้าอ่านอย่างเดียว (รวมหน้าสาธารณะที่ไม่ได้เข้าสู่ระบบ)
-- Changelog: เผยแพร่แล้ว หรือตั้งเวลาไว้และถึงเวลาแล้ว · กลุ่มผู้เห็น (แพ็กเกจ / flag / Owner-Admin / Guest) กรองที่ API
GRANT SELECT ON public.changelog_entries TO friday_app;
--> statement-breakpoint
CREATE POLICY published_read ON public.changelog_entries FOR SELECT TO friday_app
  USING (status IN ('published', 'scheduled') AND published_at <= now());
--> statement-breakpoint
GRANT SELECT ON public.nps_settings, public.help_categories TO friday_app;
--> statement-breakpoint
CREATE POLICY public_read ON public.nps_settings FOR SELECT TO friday_app USING (true);
--> statement-breakpoint
CREATE POLICY public_read ON public.help_categories FOR SELECT TO friday_app USING (true);
--> statement-breakpoint
-- บทความ: เฉพาะที่เผยแพร่ · "เฉพาะผู้เข้าสู่ระบบ" ต้องมี app.user_id · grant รายคอลัมน์เพื่อไม่ให้ร่าง (draft) และข้อมูลภายในหลุดถึงลูกค้า
GRANT SELECT (id, slug, category_id, title, summary, body, title_en, summary_en, body_en, status, visibility, app_routes, version, published_at, search_text, created_at, updated_at)
  ON public.help_articles TO friday_app;
--> statement-breakpoint
CREATE POLICY published_read ON public.help_articles FOR SELECT TO friday_app
  USING (status = 'published' AND (visibility = 'public' OR (SELECT app.user_id()) IS NOT NULL));
--> statement-breakpoint
-- ยอดอ่านใช้เรียงบทความยอดนิยม (X1) · เห็นเฉพาะของบทความที่ตัวเองเห็น
GRANT SELECT ON public.help_article_views TO friday_app;
--> statement-breakpoint
CREATE POLICY published_read ON public.help_article_views FOR SELECT TO friday_app
  USING (article_id IN (SELECT id FROM public.help_articles));
--> statement-breakpoint
-- โหวตบทความ: เพิ่มได้อย่างเดียว ไม่เห็นโหวตของคนอื่น
GRANT INSERT ON public.help_feedback TO friday_app;
--> statement-breakpoint
CREATE POLICY published_insert ON public.help_feedback FOR INSERT TO friday_app
  WITH CHECK (article_id IN (SELECT id FROM public.help_articles));
--> statement-breakpoint

-- 3. ข้อมูลของลูกค้าแยกตามผู้ใช้ / Workspace
CREATE POLICY own_rows ON public.user_ui_states TO friday_app
  USING (user_id = (SELECT app.user_id()))
  WITH CHECK (user_id = (SELECT app.user_id()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.user_ui_states TO friday_app;
--> statement-breakpoint
-- NPS: เพิ่มและอ่านได้เฉพาะคำตอบของตัวเองใน Workspace ปัจจุบัน · Owner / Admin ก็อ่านคำตอบของสมาชิกไม่ได้
-- tags / note / การติดตามเป็นของทีม Friday จึง grant รายคอลัมน์ · แก้ / ลบ (ตามระยะเก็บ 25 เดือน) ทำผ่าน friday_system
GRANT SELECT (id, workspace_id, user_id, role, plan, score, comment, topics, created_at),
  INSERT (workspace_id, user_id, role, plan, score, comment, topics)
  ON public.nps_responses TO friday_app;
--> statement-breakpoint
CREATE POLICY own_rows ON public.nps_responses TO friday_app
  USING (workspace_id = (SELECT app.workspace_id()) AND user_id = (SELECT app.user_id()) AND (SELECT app.is_member()))
  WITH CHECK (workspace_id = (SELECT app.workspace_id()) AND user_id = (SELECT app.user_id()) AND (SELECT app.is_member()));
--> statement-breakpoint
-- Onboarding: ขั้นของ Workspace (user_id ว่าง) ทุกคนใน Workspace อ่าน / บันทึกได้ (ผู้ฟังเหตุการณ์ทำงานในนามผู้ที่ทำขั้นนั้น)
-- ขั้นส่วนตัวเห็นเฉพาะเจ้าของ · บันทึกครั้งแรกแล้วไม่แก้ไม่ลบ
GRANT SELECT, INSERT ON public.onboarding_progress TO friday_app;
--> statement-breakpoint
CREATE POLICY tenant_steps ON public.onboarding_progress TO friday_app
  USING (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()) AND (user_id IS NULL OR user_id = (SELECT app.user_id())))
  WITH CHECK (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()) AND (user_id IS NULL OR user_id = (SELECT app.user_id())));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.onboarding_dismissals TO friday_app;
--> statement-breakpoint
CREATE POLICY own_rows ON public.onboarding_dismissals TO friday_app
  USING (workspace_id = (SELECT app.workspace_id()) AND user_id = (SELECT app.user_id()) AND (SELECT app.is_member()))
  WITH CHECK (workspace_id = (SELECT app.workspace_id()) AND user_id = (SELECT app.user_id()) AND (SELECT app.is_member()));
--> statement-breakpoint

-- 4. ยอดนับที่ลูกค้าเพิ่มได้แต่ห้ามอ่าน / แก้ตรง: ใช้ฟังก์ชัน SECURITY DEFINER (ทำงานในนามเจ้าของตาราง)
-- เพิ่มทีละ 1 และเฉพาะรายการที่ผู้เรียกเห็นได้ จึงปั่นตัวเลขของรายการที่ไม่ได้เผยแพร่ไม่ได้
CREATE FUNCTION app.count_changelog_views(p_entries uuid[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  INSERT INTO public.changelog_stats AS s (entry_id, views)
  SELECT e.id, 1 FROM public.changelog_entries e
  WHERE e.id = ANY (p_entries) AND app.user_id() IS NOT NULL
    AND e.status IN ('published', 'scheduled') AND e.published_at <= now()
  ON CONFLICT (entry_id) DO UPDATE SET views = s.views + 1, updated_at = now()
$$;
--> statement-breakpoint
CREATE FUNCTION app.count_changelog_click(p_entry uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  INSERT INTO public.changelog_stats AS s (entry_id, clicks)
  SELECT e.id, 1 FROM public.changelog_entries e
  WHERE e.id = p_entry AND app.user_id() IS NOT NULL
    AND e.status IN ('published', 'scheduled') AND e.published_at <= now()
  ON CONFLICT (entry_id) DO UPDATE SET clicks = s.clicks + 1, updated_at = now()
$$;
--> statement-breakpoint
-- ยอดอ่านต่อวันตามเวลาไทย
CREATE FUNCTION app.record_help_view(p_article uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  INSERT INTO public.help_article_views AS v (article_id, day, views)
  SELECT a.id, (now() AT TIME ZONE 'Asia/Bangkok')::date, 1 FROM public.help_articles a
  WHERE a.id = p_article AND a.status = 'published' AND (a.visibility = 'public' OR app.user_id() IS NOT NULL)
  ON CONFLICT (article_id, day) DO UPDATE SET views = v.views + 1
$$;
--> statement-breakpoint
-- คำค้นที่เก็บได้: ตัวพิมพ์เล็ก ตัดที่ดูเหมือนอีเมล / เบอร์โทร / เลขยาวออก ยาวไม่เกิน 100 ตัว · ว่างหรือสั้นกว่า 2 ตัว = ไม่เก็บ (null)
-- A44 ใช้ฟังก์ชันเดียวกันหาแถวที่จะเพิ่ม tickets ตอนลูกค้าเปิด Ticket ต่อจากผลค้นหาที่ไม่พบ
CREATE FUNCTION app.help_search_key(p_query text) RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT nullif(left(btrim(regexp_replace(
    regexp_replace(regexp_replace(lower(left(coalesce(p_query, ''), 300)), '\S+@\S+', ' ', 'g'), '\+?\d[\d\s().-]{6,}\d', ' ', 'g'),
    '\s+', ' ', 'g')), 100), '')
$$;
--> statement-breakpoint
CREATE FUNCTION app.record_help_search(p_query text, p_found boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  d date := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  q text := app.help_search_key(p_query);
BEGIN
  INSERT INTO public.help_search_stats AS s (day, searches, misses) VALUES (d, 1, CASE WHEN p_found THEN 0 ELSE 1 END)
  ON CONFLICT (day) DO UPDATE SET searches = s.searches + 1, misses = s.misses + EXCLUDED.misses;
  IF p_found OR q IS NULL OR char_length(q) < 2 THEN
    RETURN;
  END IF;
  INSERT INTO public.help_search_misses AS m (day, query, searches) VALUES (d, q, 1)
  ON CONFLICT (day, query) DO UPDATE SET searches = m.searches + 1;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.count_changelog_views(uuid[]), app.count_changelog_click(uuid), app.record_help_view(uuid), app.record_help_search(text, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.count_changelog_views(uuid[]), app.count_changelog_click(uuid), app.record_help_view(uuid), app.record_help_search(text, boolean), app.help_search_key(text)
  TO friday_app, friday_system;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'changelog_entries', 'changelog_stats', 'user_ui_states', 'nps_settings', 'onboarding_dismissals', 'onboarding_followups',
    'help_categories', 'help_articles', 'dev_issue_links', 'dev_bridge_settings'
  ] LOOP
    EXECUTE format('CREATE TRIGGER touch BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch()', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ค่าเริ่มต้นตามคำตัดสิน 12 พ.ย. 2569 (U5): ถาม Owner / Admin หลังใช้ 30 วัน ซ้ำทุก 90 วัน สุ่ม 50%
INSERT INTO public.nps_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
-- หมวดเริ่มต้นตามหน้าศูนย์ช่วยเหลือ (X1 / X9) · ทีม Friday แก้ชื่อ / ลำดับต่อได้ใน Ops
INSERT INTO public.help_categories (slug, name, name_en, position) VALUES
  ('getting-started', 'เริ่มต้นใช้งาน', 'Getting started', 1),
  ('projects-issues', 'โปรเจกต์และงาน', 'Projects and issues', 2),
  ('gantt-planning', 'Gantt และแผนงาน', 'Gantt and planning', 3),
  ('import-export', 'นำเข้า / ส่งออก Excel', 'Excel import / export', 4),
  ('notifications', 'แจ้งเตือน LINE และอีเมล', 'LINE and email notifications', 5),
  ('members-permissions', 'สมาชิกและสิทธิ์', 'Members and permissions', 6),
  ('billing', 'แพ็กเกจและการชำระเงิน', 'Plans and billing', 7),
  ('api-integrations', 'API, Webhook และ GitHub', 'API, webhooks and GitHub', 8)
ON CONFLICT (slug) DO NOTHING;