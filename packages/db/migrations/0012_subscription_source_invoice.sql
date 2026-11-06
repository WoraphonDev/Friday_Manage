-- N01/N02: จดใบแจ้งหนี้ที่เปิดสิทธิ์ปัจจุบัน แทนการเดาจากวันเริ่มรอบ (หลายใบในวันเดียวกันมีวันเริ่มตรงกันได้)
ALTER TABLE "subscriptions" ADD COLUMN "source_invoice_id" uuid;--> statement-breakpoint
-- ข้อมูลเดิม: ใบล่าสุดที่ชำระแล้วหรือรอตรวจสลิป และวันเริ่มตรงกับรอบปัจจุบัน
UPDATE "subscriptions" s SET "source_invoice_id" = (
  SELECT i.id FROM "invoices" i
  WHERE i.subscription_id = s.id AND i.status IN ('paid', 'pending_review')
    AND s.current_period_start = (i.period_start::timestamp AT TIME ZONE 'Asia/Bangkok')
  ORDER BY i.created_at DESC, i.id DESC LIMIT 1
) WHERE s.status = 'active';
