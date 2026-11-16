-- ลูกค้าหักเครดิตของตัวเองตอนสร้างใบแจ้งหนี้ (O41 · R) ในธุรกรรมเดียวกับ checkout ซึ่งรันด้วย friday_app
-- เขียนได้เฉพาะแถว applied ที่ติดลบ ของ Workspace ตัวเอง และต้องผูกใบแจ้งหนี้ (FK tenant บังคับให้เป็นใบของ Workspace เดียวกัน)
-- แถวติดลบมีแต่ลดเครดิตของตัวเอง ลูกค้าจึงสร้างเครดิตให้ตัวเองไม่ได้ · ให้เครดิต / คืน / ใบลดหนี้ ยังเป็นของทีม Friday เท่านั้น
GRANT INSERT ON public.workspace_credits TO friday_app;
--> statement-breakpoint
CREATE POLICY tenant_apply ON public.workspace_credits FOR INSERT TO friday_app
  WITH CHECK (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()) AND source = 'applied' AND amount_satang < 0 AND invoice_id IS NOT NULL);
