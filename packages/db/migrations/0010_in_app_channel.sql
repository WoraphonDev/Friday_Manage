-- A23: Profile ปิด In-app รายเหตุการณ์ได้ · เพิ่มค่าอย่างเดียว ไม่แก้คอลัมน์เดิม
ALTER TYPE "public"."notification_channel" ADD VALUE 'in_app';--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_external_channel" CHECK ("notification_deliveries"."channel"::text <> 'in_app');