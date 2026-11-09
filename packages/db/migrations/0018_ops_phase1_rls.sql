-- O00: RLS, สิทธิ์ และ trigger ของตาราง Friday Ops เฟส 1 และข้อมูลธุรกิจ · ใช้ฟังก์ชัน app.* จาก migration 0001
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'staff_elevations', 'approval_requests', 'staff_audit_logs', 'support_tickets', 'support_ticket_messages',
    'incidents', 'incident_updates', 'maintenance_windows', 'status_subscribers',
    'credit_notes', 'workspace_credits', 'dunning_events',
    'signup_attributions', 'workspace_acquisitions', 'product_events', 'subscription_changes', 'cancellation_responses',
    'daily_usages', 'cost_rates', 'infra_costs', 'marketing_costs'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ข้อมูลของลูกค้าที่แอปเขียนในบริบทของ Workspace (เหตุการณ์ในแอป, ประวัติแพ็กเกจ, แบบสอบถามตอนยกเลิก)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['product_events', 'subscription_changes', 'cancellation_responses'] LOOP
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I TO friday_app
        USING (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()))
        WITH CHECK (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()))', t);
    -- append-only สำหรับแอป · ลบตามระยะเก็บและทำให้ระบุตัวไม่ได้ทำผ่าน friday_system
    EXECUTE format('REVOKE UPDATE, DELETE ON public.%I FROM friday_app', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ใบลดหนี้และเครดิต: ลูกค้าอ่านของ Workspace ตัวเองได้ (หน้าแพ็กเกจ) แต่ออกเอกสารได้เฉพาะทีม Friday
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['credit_notes', 'workspace_credits'] LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM friday_app', t);
    EXECUTE format(
      'CREATE POLICY tenant_read ON public.%I FOR SELECT TO friday_app
        USING (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()))', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- สถานะระบบที่ลูกค้าต้องเห็น: เหตุขัดข้องที่เผยแพร่แล้ว และช่วงปิดปรับปรุง (API อ่านเพื่อเปลี่ยนเป็นอ่านอย่างเดียว)
REVOKE INSERT, UPDATE, DELETE ON public.incidents, public.incident_updates, public.maintenance_windows FROM friday_app;
--> statement-breakpoint
CREATE POLICY public_read ON public.incidents FOR SELECT TO friday_app USING (NOT internal);
--> statement-breakpoint
CREATE POLICY public_read ON public.incident_updates FOR SELECT TO friday_app
  USING (incident_id IN (SELECT id FROM public.incidents WHERE NOT internal));
--> statement-breakpoint
CREATE POLICY public_read ON public.maintenance_windows FOR SELECT TO friday_app USING (status <> 'cancelled');
--> statement-breakpoint

-- ใช้เฉพาะทีม Friday (ops-api ผ่าน friday_worker) · ปิดอย่างชัดเจน แม้เผลอ grant สิทธิ์ในอนาคตก็ยังอ่าน/เขียนไม่ได้
-- Ticket ที่ลูกค้าส่งจากในแอปให้ API เขียนผ่าน SYSTEM_DB พร้อมเหตุผล เพราะข้อความภายในของทีมต้องไม่หลุดถึงลูกค้า
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'staff_elevations', 'approval_requests', 'staff_audit_logs', 'support_tickets', 'support_ticket_messages', 'status_subscribers',
    'dunning_events', 'signup_attributions', 'workspace_acquisitions', 'daily_usages', 'cost_rates', 'infra_costs', 'marketing_costs'
  ] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM friday_app', t);
    EXECUTE format('CREATE POLICY ops_only ON public.%I TO friday_app USING (false) WITH CHECK (false)', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- Audit log ของทีม Friday แก้หรือลบไม่ได้ แม้แต่ role ของ ops
REVOKE UPDATE, DELETE, TRUNCATE ON public.staff_audit_logs FROM friday_system;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['approval_requests', 'support_tickets', 'incidents', 'maintenance_windows', 'credit_notes'] LOOP
    EXECUTE format('CREATE TRIGGER touch BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch()', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ระหว่างที่ ops-api ยังเขียน staff_users.role แบบเดิม (ก่อน O01) ให้เติม roles ให้ตรงกัน · admin → owner
CREATE FUNCTION app.staff_sync_roles() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role IS NOT NULL AND (
    (TG_OP = 'INSERT' AND cardinality(NEW.roles) = 0) OR
    (TG_OP = 'UPDATE' AND NEW.role IS DISTINCT FROM OLD.role AND NEW.roles = OLD.roles)
  ) THEN
    NEW.roles := CASE NEW.role WHEN 'admin' THEN ARRAY['owner'] WHEN 'finance' THEN ARRAY['finance'] ELSE ARRAY['support'] END;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER staff_users_sync_roles BEFORE INSERT OR UPDATE ON public.staff_users FOR EACH ROW EXECUTE FUNCTION app.staff_sync_roles();
