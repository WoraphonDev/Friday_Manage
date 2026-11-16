-- RLS ของตารางใน 0038 + เติมวันที่ของเอกสารเดิม
ALTER TABLE public.quotations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.debit_notes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- ใบเสนอราคา: ลูกค้าสร้างและอ่านของ Workspace ตัวเอง · ออกแล้วแก้ / ลบไม่ได้ (ใช้อ้างอิงย้อนหลัง)
CREATE POLICY tenant_isolation ON public.quotations TO friday_app
  USING (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()))
  WITH CHECK (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON public.quotations FROM friday_app;
--> statement-breakpoint
-- ใบเพิ่มหนี้: เหมือนใบลดหนี้ ลูกค้าอ่านได้ ออกเอกสารได้เฉพาะทีม Friday
REVOKE INSERT, UPDATE, DELETE ON public.debit_notes FROM friday_app;
--> statement-breakpoint
CREATE POLICY tenant_read ON public.debit_notes FOR SELECT TO friday_app
  USING (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()));
--> statement-breakpoint
CREATE TRIGGER touch BEFORE UPDATE ON public.debit_notes FOR EACH ROW EXECUTE FUNCTION app.touch();
--> statement-breakpoint
-- เอกสารก่อนมีคอลัมน์: วันที่ใบกำกับภาษี / เวลารับเงิน = เวลาที่ใบแจ้งหนี้ปิด (เวลาไทย)
UPDATE public.tax_documents d SET issued_on = (i.paid_at AT TIME ZONE 'Asia/Bangkok')::date
  FROM public.invoices i WHERE i.id = d.invoice_id AND d.issued_on IS NULL AND i.paid_at IS NOT NULL;
--> statement-breakpoint
UPDATE public.payments p SET paid_at = i.paid_at
  FROM public.invoices i WHERE i.id = p.invoice_id AND p.paid_at IS NULL AND p.status = 'confirmed' AND i.paid_at IS NOT NULL;
