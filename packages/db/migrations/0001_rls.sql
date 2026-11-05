-- Row-Level Security, role และ trigger ของ Friday Manage
-- อ่านคู่กับ docs/spec/04-permissions.md ข้อ 5
--
-- หลักการ
--   * friday_app    : role ที่ API ใช้ตอนทำงาน ถูกบังคับด้วย RLS ทุกตาราง
--   * friday_system : role ของงานเบื้องหลัง, Auth และ Webhook ขาเข้า (BYPASSRLS) ใช้เฉพาะจุดที่ยังไม่รู้ Workspace
--   * เจ้าของตาราง (ผู้รัน migration) ไม่ใช้ตอนทำงาน
--   * API ตั้งค่าต่อธุรกรรม: set_config('app.user_id', …, true) และ set_config('app.workspace_id', …, true)
--   * RLS ตรวจ 2 ชั้น: (1) แยก Workspace และต้องเป็นสมาชิก active (2) เข้าถึงโปรเจกต์ได้
--   * สิทธิ์ละเอียด (issue.edit ฯลฯ) และเพดานของ Guest ตรวจที่ API ไม่ใช่ที่นี่

-- ---------------------------------------------------------------------------
-- 1. Role (production สร้างโดย infra · ที่นี่สร้างเฉพาะเมื่อยังไม่มี)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'friday_app') THEN
    CREATE ROLE friday_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'friday_system') THEN
    CREATE ROLE friday_system NOLOGIN BYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. ฟังก์ชันช่วย
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint

CREATE FUNCTION app.workspace_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;
--> statement-breakpoint

CREATE FUNCTION app.user_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint

-- Role ของผู้ใช้ใน Workspace ปัจจุบัน (null = ไม่ใช่สมาชิก active)
-- SECURITY DEFINER เพื่ออ่าน workspace_members โดยไม่วนกลับเข้า policy ของตัวเอง
CREATE FUNCTION app.ws_role() RETURNS public.workspace_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT wm.role
  FROM public.workspace_members wm
  JOIN public.workspaces w ON w.id = wm.workspace_id
  WHERE wm.workspace_id = app.workspace_id()
    AND wm.user_id = app.user_id()
    AND wm.status = 'active'
    AND w.deleted_at IS NULL
$$;
--> statement-breakpoint

CREATE FUNCTION app.is_member() RETURNS boolean
LANGUAGE sql STABLE
AS $$ SELECT app.ws_role() IS NOT NULL $$;
--> statement-breakpoint

CREATE FUNCTION app.is_ws_admin() RETURNS boolean
LANGUAGE sql STABLE
AS $$ SELECT coalesce(app.ws_role() IN ('owner', 'admin'), false) $$;
--> statement-breakpoint

-- โปรเจกต์ที่ผู้ใช้เปิดงานได้ (04-permissions ข้อ 5)
--   * Project Owner หรือสมาชิกโปรเจกต์ (รวม Guest ที่ถูกเชิญ)
--   * โปรเจกต์ visibility = workspace สำหรับสมาชิกที่ไม่ใช่ Guest
--   * Workspace Owner / Admin ไม่อยู่ในรายการนี้จนกว่าจะ "เข้าร่วมในฐานะ Admin"
CREATE FUNCTION app.accessible_project_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT p.id
  FROM public.projects p
  WHERE p.workspace_id = app.workspace_id()
    AND app.is_member()
    AND (
      p.owner_user_id = app.user_id()
      OR EXISTS (
        SELECT 1 FROM public.project_members pm
        WHERE pm.project_id = p.id AND pm.user_id = app.user_id()
      )
      OR (p.visibility = 'workspace' AND app.ws_role() IN ('owner', 'admin', 'member'))
    )
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.ws_role(), app.accessible_project_ids() FROM PUBLIC;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. สิทธิ์ระดับตาราง
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public, app TO friday_app, friday_system;
--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO friday_app, friday_system;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO friday_app;
--> statement-breakpoint
GRANT ALL ON ALL TABLES IN SCHEMA public TO friday_system;
--> statement-breakpoint

-- ประวัติแก้ไม่ได้
REVOKE UPDATE, DELETE ON public.audit_logs, public.activities FROM friday_app;
--> statement-breakpoint
-- สร้าง / ลบ Workspace และบัญชีผู้ใช้ทำผ่าน friday_system (Onboarding, Sign up)
REVOKE INSERT, DELETE ON public.workspaces, public.users FROM friday_app;
--> statement-breakpoint
-- token ที่ส่งทางอีเมลใช้เฉพาะ friday_system
REVOKE ALL ON public.auth_tokens FROM friday_app;
--> statement-breakpoint
-- แจ้งเตือนสร้างโดยงานเบื้องหลัง
REVOKE INSERT ON public.notifications FROM friday_app;
--> statement-breakpoint

-- ตารางที่สร้างใน migration ถัดไปได้สิทธิ์เดียวกัน (แต่ต้องเปิด RLS เอง · มี test ตรวจ)
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO friday_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO friday_system;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. เปิด RLS ทุกตารางใน public (ไม่มี policy = ไม่เห็นอะไรเลย)
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. ชั้นที่ 1: แยก Workspace + ต้องเป็นสมาชิก active
--    ใช้ (SELECT …) ให้ PostgreSQL คำนวณครั้งเดียวต่อคำสั่ง ไม่ใช่ทุกแถว
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspace_settings', 'security_policies', 'invitations', 'invite_links', 'access_requests',
    'teams', 'team_members', 'leaves',
    'projects', 'project_key_aliases', 'project_scope_items', 'project_holidays', 'project_members',
    'project_role_permissions', 'modules', 'phases', 'milestones', 'sprints', 'sprint_daily_snapshots',
    'workflows', 'workflow_statuses', 'workflow_rules', 'issue_types', 'custom_fields', 'labels',
    'issues', 'issue_assignees', 'issue_watchers', 'issue_labels', 'requirements', 'issue_requirements',
    'screens', 'issue_screens', 'issue_dependencies', 'checklist_items', 'comments', 'comment_mentions',
    'activities', 'time_logs', 'test_runs', 'due_change_requests', 'issue_custom_values', 'milestone_issues',
    'plan_baselines', 'baseline_items', 'plan_changes', 'import_jobs',
    'folders', 'files', 'file_versions', 'file_attachments',
    'audit_logs'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I TO friday_app
         USING (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()))
         WITH CHECK (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()))',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. ชั้นที่ 2: ต้องเข้าถึงโปรเจกต์ได้ (RESTRICTIVE = ต้องผ่านทั้งชั้น 1 และชั้นนี้)
-- ---------------------------------------------------------------------------

-- 6.1 ตารางที่มี project_id
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'project_key_aliases', 'project_scope_items', 'project_holidays', 'project_role_permissions',
    'modules', 'phases', 'milestones', 'sprints', 'workflows', 'workflow_statuses', 'workflow_rules',
    'issue_types', 'custom_fields', 'labels', 'issues', 'requirements', 'screens', 'activities',
    'plan_baselines', 'plan_changes', 'folders', 'files'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY project_access ON public.%I AS RESTRICTIVE TO friday_app
         USING (project_id IN (SELECT app.accessible_project_ids()))
         WITH CHECK (project_id IN (SELECT app.accessible_project_ids()))',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- 6.2 ตารางลูกของงาน: เห็นได้เมื่อเห็นงานแม่ (policy ของ issues ทำงานใน subquery ด้วย)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'issue_assignees', 'issue_watchers', 'issue_labels', 'issue_requirements', 'issue_screens',
    'checklist_items', 'comments', 'time_logs', 'test_runs', 'due_change_requests',
    'issue_custom_values', 'milestone_issues', 'baseline_items'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY issue_access ON public.%I AS RESTRICTIVE TO friday_app
         USING (issue_id IN (SELECT id FROM public.issues))
         WITH CHECK (issue_id IN (SELECT id FROM public.issues))',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

CREATE POLICY issue_access ON public.issue_dependencies AS RESTRICTIVE TO friday_app
  USING (predecessor_id IN (SELECT id FROM public.issues) AND successor_id IN (SELECT id FROM public.issues))
  WITH CHECK (predecessor_id IN (SELECT id FROM public.issues) AND successor_id IN (SELECT id FROM public.issues));
--> statement-breakpoint

CREATE POLICY comment_access ON public.comment_mentions AS RESTRICTIVE TO friday_app
  USING (comment_id IN (SELECT id FROM public.comments))
  WITH CHECK (comment_id IN (SELECT id FROM public.comments));
--> statement-breakpoint

CREATE POLICY sprint_access ON public.sprint_daily_snapshots AS RESTRICTIVE TO friday_app
  USING (sprint_id IN (SELECT id FROM public.sprints))
  WITH CHECK (sprint_id IN (SELECT id FROM public.sprints));
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['file_versions', 'file_attachments'] LOOP
    EXECUTE format(
      'CREATE POLICY file_access ON public.%I AS RESTRICTIVE TO friday_app
         USING (file_id IN (SELECT id FROM public.files))
         WITH CHECK (file_id IN (SELECT id FROM public.files))',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

CREATE POLICY project_access ON public.import_jobs AS RESTRICTIVE TO friday_app
  USING (project_id IS NULL OR project_id IN (SELECT app.accessible_project_ids()))
  WITH CHECK (project_id IS NULL OR project_id IN (SELECT app.accessible_project_ids()));
--> statement-breakpoint

-- 6.3 projects: Workspace Owner / Admin เห็นแถวโปรเจกต์ (ชื่อ, PM, สถานะ) แม้ไม่ได้เป็นสมาชิก
--     ผู้สร้างโปรเจกต์ใส่ตัวเองเป็น owner_user_id จึงผ่าน WITH CHECK ตอนสร้าง
CREATE POLICY project_access ON public.projects AS RESTRICTIVE TO friday_app
  USING (id IN (SELECT app.accessible_project_ids()) OR (SELECT app.is_ws_admin()))
  WITH CHECK (
    owner_user_id = (SELECT app.user_id())
    OR id IN (SELECT app.accessible_project_ids())
    OR (SELECT app.is_ws_admin())
  );
--> statement-breakpoint

-- 6.4 project_members: Workspace Owner / Admin เห็นรายชื่อสมาชิกและ "เข้าร่วมในฐานะ Admin" ได้
CREATE POLICY project_access ON public.project_members AS RESTRICTIVE TO friday_app
  USING (project_id IN (SELECT app.accessible_project_ids()) OR (SELECT app.is_ws_admin()))
  WITH CHECK (project_id IN (SELECT app.accessible_project_ids()) OR (SELECT app.is_ws_admin()));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. ตารางที่มีกติกาเฉพาะ
-- ---------------------------------------------------------------------------

-- 7.1 users: เห็นตัวเองและคนใน Workspace ปัจจุบัน · แก้ได้แค่ตัวเอง
CREATE POLICY users_select ON public.users FOR SELECT TO friday_app
  USING (
    id = (SELECT app.user_id())
    OR id IN (SELECT user_id FROM public.workspace_members WHERE workspace_id = (SELECT app.workspace_id()))
  );
--> statement-breakpoint
CREATE POLICY users_update ON public.users FOR UPDATE TO friday_app
  USING (id = (SELECT app.user_id()))
  WITH CHECK (id = (SELECT app.user_id()));
--> statement-breakpoint

-- 7.2 ข้อมูลล็อกอินของตัวเอง
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_identities', 'mfa_factors', 'user_sessions'] LOOP
    EXECUTE format(
      'CREATE POLICY own_rows ON public.%I TO friday_app
         USING (user_id = (SELECT app.user_id()))
         WITH CHECK (user_id = (SELECT app.user_id()))',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- 7.3 workspaces: เห็นทุก Workspace ที่ตัวเองเป็นสมาชิก (เมนูสลับ Workspace) · แก้ได้เฉพาะ Owner / Admin
CREATE POLICY workspaces_select ON public.workspaces FOR SELECT TO friday_app
  USING (
    id IN (
      SELECT workspace_id FROM public.workspace_members
      WHERE user_id = (SELECT app.user_id()) AND status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY workspaces_update ON public.workspaces FOR UPDATE TO friday_app
  USING (id = (SELECT app.workspace_id()) AND (SELECT app.is_ws_admin()))
  WITH CHECK (id = (SELECT app.workspace_id()) AND (SELECT app.is_ws_admin()));
--> statement-breakpoint

-- 7.4 workspace_members: เห็นสมาชิกใน Workspace ปัจจุบัน และแถวของตัวเองทุก Workspace
--     เพิ่ม / แก้ / ลบ เฉพาะ Owner / Admin (ตอบรับคำเชิญทำผ่าน friday_system)
CREATE POLICY members_select ON public.workspace_members FOR SELECT TO friday_app
  USING (
    (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()))
    OR user_id = (SELECT app.user_id())
  );
--> statement-breakpoint
CREATE POLICY members_write ON public.workspace_members FOR ALL TO friday_app
  USING (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_ws_admin()))
  WITH CHECK (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_ws_admin()));
--> statement-breakpoint

-- 7.5 ปฏิทินวันหยุด: ของระบบ (workspace_id = null) อ่านได้ทุกคน แก้ไม่ได้
CREATE POLICY calendars_select ON public.holiday_calendars FOR SELECT TO friday_app
  USING (workspace_id IS NULL OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member())));
--> statement-breakpoint
CREATE POLICY calendars_write ON public.holiday_calendars FOR ALL TO friday_app
  USING (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()))
  WITH CHECK (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()));
--> statement-breakpoint
CREATE POLICY holidays_select ON public.holidays FOR SELECT TO friday_app
  USING (calendar_id IN (SELECT id FROM public.holiday_calendars));
--> statement-breakpoint
CREATE POLICY holidays_write ON public.holidays FOR ALL TO friday_app
  USING (calendar_id IN (SELECT id FROM public.holiday_calendars WHERE workspace_id = (SELECT app.workspace_id())))
  WITH CHECK (calendar_id IN (SELECT id FROM public.holiday_calendars WHERE workspace_id = (SELECT app.workspace_id())));
--> statement-breakpoint

-- 7.6 notifications: เห็นเฉพาะของตัวเอง (ข้าม Workspace ได้ สำหรับกระดิ่งรวม)
CREATE POLICY own_notifications ON public.notifications TO friday_app
  USING (recipient_id = (SELECT app.user_id()))
  WITH CHECK (recipient_id = (SELECT app.user_id()));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. Trigger
-- ---------------------------------------------------------------------------

-- 8.1 updated_at และ version (ใช้ตรวจ If-Match / 409)
CREATE FUNCTION app.touch() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_ARGV[0] = 'versioned' THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE TRIGGER touch BEFORE UPDATE ON public.issues FOR EACH ROW EXECUTE FUNCTION app.touch('versioned');
--> statement-breakpoint
CREATE TRIGGER touch BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION app.touch('versioned');
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'workspaces', 'workspace_settings', 'security_policies', 'project_role_permissions'] LOOP
    EXECUTE format('CREATE TRIGGER touch BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch()', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- 8.2 ลำดับชั้นงานลึกสุด 2 ชั้น และงานแม่ต้องอยู่โปรเจกต์เดียวกัน (01-entities กติกาข้อ 1)
CREATE FUNCTION app.check_issue_hierarchy() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  p_parent uuid;
  p_project uuid;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT parent_id, project_id INTO p_parent, p_project FROM public.issues WHERE id = NEW.parent_id;

  IF p_parent IS NOT NULL THEN
    RAISE EXCEPTION 'issue_depth_exceeded'
      USING ERRCODE = 'check_violation', DETAIL = 'Sub-task ต้องอยู่ใต้งานระดับ Task เท่านั้น';
  END IF;
  IF p_project IS DISTINCT FROM NEW.project_id THEN
    RAISE EXCEPTION 'parent_in_other_project'
      USING ERRCODE = 'check_violation', DETAIL = 'งานแม่ต้องอยู่ในโปรเจกต์เดียวกัน';
  END IF;
  IF EXISTS (SELECT 1 FROM public.issues c WHERE c.parent_id = NEW.id) THEN
    RAISE EXCEPTION 'issue_depth_exceeded'
      USING ERRCODE = 'check_violation', DETAIL = 'งานที่มี Sub-task อยู่แล้วย้ายไปเป็น Sub-task ไม่ได้';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE TRIGGER check_hierarchy BEFORE INSERT OR UPDATE OF parent_id, project_id ON public.issues
  FOR EACH ROW EXECUTE FUNCTION app.check_issue_hierarchy();
