-- O01: ops-api ย้ายไปใช้ staff_users.roles แล้ว · เลิกเติมค่าจาก role เดิม
DROP TRIGGER IF EXISTS staff_users_sync_roles ON public.staff_users;--> statement-breakpoint
DROP FUNCTION IF EXISTS app.staff_sync_roles();--> statement-breakpoint
ALTER TABLE "staff_users" DROP COLUMN "role";
