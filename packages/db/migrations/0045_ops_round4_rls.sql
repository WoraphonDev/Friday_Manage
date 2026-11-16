-- RLS ของตารางใน 0044 (รอบ 4 · งานค้าง Friday Ops) · ทุกตารางใช้เฉพาะทีม Friday (ops-api ผ่าน friday_worker) และงานเบื้องหลังผ่าน friday_system
-- ปิด friday_app อย่างชัดเจนแบบ 0018 · คิว e-Tax และการขอ 50 ทวิ ลูกค้าไม่ต้องเห็น (หน้า Billing อ่านจากใบแจ้งหนี้ / 50 ทวิ ที่มีอยู่)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ops_settings', 'legal_holds', 'system_alerts', 'legal_notices', 'etax_jobs', 'wht_requests'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM friday_app', t);
    EXECUTE format('CREATE POLICY ops_only ON public.%I TO friday_app USING (false) WITH CHECK (false)', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TRIGGER touch BEFORE UPDATE ON public.ops_settings FOR EACH ROW EXECUTE FUNCTION app.touch();
--> statement-breakpoint
CREATE TRIGGER touch BEFORE UPDATE ON public.etax_jobs FOR EACH ROW EXECUTE FUNCTION app.touch();
--> statement-breakpoint
-- วันหยุดที่มีอยู่แล้วในปฏิทินของระบบมาจากประกาศ ธปท.
UPDATE public.holidays h SET origin = 'bot'
  FROM public.holiday_calendars c WHERE c.id = h.calendar_id AND c.workspace_id IS NULL AND h.origin IS NULL;
