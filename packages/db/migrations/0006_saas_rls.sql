-- T00: RLS ของ 44 ตารางใหม่ · ใช้ฟังก์ชัน app.* จาก migration 0001
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'line_bindings', 'line_link_codes', 'calendar_feed_tokens',
    'sso_connections', 'verified_domains', 'project_templates',
    'git_installations', 'git_repositories', 'project_repositories', 'git_commits', 'pull_requests', 'issue_git_links',
    'notification_deliveries', 'user_notification_prefs', 'user_notification_settings',
    'line_oa_configs', 'line_groups', 'email_sender_configs', 'webhook_endpoints',
    'project_notification_rules', 'project_notification_settings', 'report_schedules',
    'automation_rules', 'automation_runs', 'saved_views', 'saved_searches', 'api_tokens',
    'data_subject_requests', 'workspace_exports',
    'plans', 'subscriptions', 'billing_profiles', 'invoices', 'payments', 'tax_documents', 'wht_certificates',
    'legal_documents', 'legal_acceptances',
    'staff_users', 'support_access_grants', 'support_sessions', 'feature_flags', 'feature_flag_overrides', 'announcements'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'calendar_feed_tokens', 'sso_connections', 'verified_domains', 'project_templates',
    'git_installations', 'git_repositories', 'project_repositories', 'git_commits', 'pull_requests', 'issue_git_links',
    'notification_deliveries', 'user_notification_prefs', 'user_notification_settings',
    'line_oa_configs', 'line_groups', 'email_sender_configs', 'webhook_endpoints',
    'project_notification_rules', 'project_notification_settings', 'report_schedules',
    'automation_rules', 'automation_runs', 'saved_views', 'saved_searches', 'api_tokens',
    'data_subject_requests', 'workspace_exports', 'subscriptions', 'billing_profiles',
    'invoices', 'payments', 'tax_documents', 'wht_certificates'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I TO friday_app
        USING (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()))
        WITH CHECK (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()))', t);
  END LOOP;
END $$;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'project_repositories', 'project_notification_rules', 'project_notification_settings',
    'report_schedules', 'automation_rules', 'saved_views'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY project_access ON public.%I AS RESTRICTIVE TO friday_app
        USING (project_id IN (SELECT app.accessible_project_ids()))
        WITH CHECK (project_id IN (SELECT app.accessible_project_ids()))', t);
  END LOOP;
END $$;
--> statement-breakpoint

CREATE POLICY project_access ON public.calendar_feed_tokens AS RESTRICTIVE TO friday_app
  USING (project_id IS NULL OR project_id IN (SELECT app.accessible_project_ids()))
  WITH CHECK (project_id IS NULL OR project_id IN (SELECT app.accessible_project_ids()));
--> statement-breakpoint

CREATE POLICY issue_access ON public.issue_git_links AS RESTRICTIVE TO friday_app
  USING (issue_id IN (SELECT id FROM public.issues))
  WITH CHECK (issue_id IN (SELECT id FROM public.issues));
--> statement-breakpoint

-- ประวัติ commit / PR ต้องมาจาก repo ที่ผูกกับโปรเจกต์ที่เปิดได้
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['git_commits', 'pull_requests'] LOOP
    EXECUTE format(
      'CREATE POLICY repository_access ON public.%I AS RESTRICTIVE TO friday_app
        USING (repository_id IN (SELECT repository_id FROM public.project_repositories))
        WITH CHECK (repository_id IN (SELECT repository_id FROM public.project_repositories))', t);
  END LOOP;
END $$;
--> statement-breakpoint

CREATE POLICY rule_access ON public.automation_runs AS RESTRICTIVE TO friday_app
  USING (rule_id IN (SELECT id FROM public.automation_rules))
  WITH CHECK (rule_id IN (SELECT id FROM public.automation_rules));
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['line_bindings', 'line_link_codes'] LOOP
    EXECUTE format(
      'CREATE POLICY own_rows ON public.%I TO friday_app
        USING (user_id = (SELECT app.user_id()))
        WITH CHECK (user_id = (SELECT app.user_id()))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['calendar_feed_tokens', 'user_notification_prefs', 'user_notification_settings', 'saved_searches'] LOOP
    EXECUTE format(
      'CREATE POLICY own_rows ON public.%I AS RESTRICTIVE TO friday_app
        USING (user_id = (SELECT app.user_id()))
        WITH CHECK (user_id = (SELECT app.user_id()))', t);
  END LOOP;
END $$;
--> statement-breakpoint

CREATE POLICY own_or_shared ON public.saved_views AS RESTRICTIVE TO friday_app
  USING (owner_id IS NULL OR owner_id = (SELECT app.user_id()))
  WITH CHECK (owner_id IS NULL OR owner_id = (SELECT app.user_id()));
--> statement-breakpoint

-- รับทราบกฎหมายตอนสมัครได้ก่อนมี Workspace แต่ห้ามอ้าง Workspace ที่ตนไม่ได้อยู่
CREATE POLICY own_rows ON public.legal_acceptances TO friday_app
  USING (user_id = (SELECT app.user_id()) AND
    (workspace_id IS NULL OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()))))
  WITH CHECK (user_id = (SELECT app.user_id()) AND
    (workspace_id IS NULL OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()))));
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['plans', 'legal_documents'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM friday_app', t);
    EXECUTE format('GRANT SELECT ON public.%I TO friday_app', t);
    EXECUTE format('CREATE POLICY public_read ON public.%I FOR SELECT TO friday_app USING (true)', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY[
    'staff_users', 'support_access_grants', 'support_sessions', 'feature_flags', 'feature_flag_overrides', 'announcements'
  ] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM friday_app', t);
    -- ปิดอย่างชัดเจน แม้เผลอ grant สิทธิ์ในอนาคตก็ยังอ่าน/เขียนไม่ได้
    EXECUTE format('CREATE POLICY ops_only ON public.%I TO friday_app USING (false) WITH CHECK (false)', t);
  END LOOP;
END $$;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sso_connections', 'project_templates', 'git_installations', 'git_repositories', 'project_repositories', 'pull_requests',
    'notification_deliveries', 'user_notification_prefs', 'user_notification_settings',
    'line_oa_configs', 'email_sender_configs', 'webhook_endpoints', 'project_notification_rules', 'project_notification_settings',
    'report_schedules', 'automation_rules', 'saved_views', 'saved_searches', 'data_subject_requests', 'workspace_exports',
    'plans', 'subscriptions', 'billing_profiles', 'invoices', 'payments', 'tax_documents', 'wht_certificates',
    'staff_users', 'support_access_grants', 'feature_flags', 'feature_flag_overrides', 'announcements'
  ] LOOP
    EXECUTE format('CREATE TRIGGER touch BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch()', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- Team ทุกขนาดมีฟีเจอร์เท่ากัน · ราคาและ storage ยังไม่ตกลงจึงเก็บ null
INSERT INTO public.plans (code, seat_limit, features, price_monthly_satang, price_yearly_satang) VALUES
  ('free', 5, '{}', NULL, NULL),
  ('team_s', 10, '{"tier":"team"}', NULL, NULL),
  ('team_m', 25, '{"tier":"team"}', NULL, NULL),
  ('team_l', 50, '{"tier":"team"}', NULL, NULL),
  ('enterprise', NULL, '{"tier":"enterprise"}', NULL, NULL);
