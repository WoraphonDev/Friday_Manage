ALTER TABLE "project_members" ADD COLUMN "visible_while_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "paused_by" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_paused_by_users_id_fk" FOREIGN KEY ("paused_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- พักโปรเจกต์: ระหว่างพักเปิดได้เฉพาะ Project Owner, Admin ของโปรเจกต์, สมาชิกที่ PM เลือก (visible_while_paused)
-- และ Workspace Owner / Admin ที่ปกติเปิดได้อยู่แล้ว · ทุกตารางใต้โปรเจกต์ใช้ฟังก์ชันนี้ จึงซ่อนงาน คอมเมนต์ ไฟล์ ฯลฯ ตามกันหมด
CREATE OR REPLACE FUNCTION app.accessible_project_ids() RETURNS SETOF uuid
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
    AND (
      p.paused_at IS NULL
      OR p.owner_user_id = app.user_id()
      OR app.ws_role() IN ('owner', 'admin')
      OR EXISTS (
        SELECT 1 FROM public.project_members pm
        WHERE pm.project_id = p.id AND pm.user_id = app.user_id() AND (pm.role = 'admin' OR pm.visible_while_paused)
      )
    )
$$;
--> statement-breakpoint
-- Inbox: ซ่อนแจ้งเตือนของโปรเจกต์ที่ลบแล้ว (ถังขยะ / ลบถาวร) และโปรเจกต์ที่พักซึ่งผู้รับมองไม่เห็น
-- ข้าม Workspace ได้ (กระดิ่งรวมไม่มี app.workspace_id) จึงตรวจจาก workspace ของโปรเจกต์เอง · กู้คืน / เปิดใช้งานต่อแล้วกลับมาเหมือนเดิม
CREATE FUNCTION app.inbox_project_visible(pid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = pid
      AND p.deleted_at IS NULL
      AND (
        p.paused_at IS NULL
        OR p.owner_user_id = app.user_id()
        OR EXISTS (
          SELECT 1 FROM public.workspace_members wm
          WHERE wm.workspace_id = p.workspace_id AND wm.user_id = app.user_id() AND wm.status = 'active' AND wm.role IN ('owner', 'admin')
        )
        OR EXISTS (
          SELECT 1 FROM public.project_members pm
          WHERE pm.project_id = p.id AND pm.user_id = app.user_id() AND (pm.role = 'admin' OR pm.visible_while_paused)
        )
      )
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.inbox_project_visible(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.inbox_project_visible(uuid) TO friday_app, friday_system;
--> statement-breakpoint
DROP POLICY own_notifications ON public.notifications;
--> statement-breakpoint
CREATE POLICY own_notifications ON public.notifications TO friday_app
  USING (recipient_id = (SELECT app.user_id()) AND in_app AND (project_id IS NULL OR app.inbox_project_visible(project_id)))
  WITH CHECK (recipient_id = (SELECT app.user_id()));
