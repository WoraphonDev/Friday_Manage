CREATE TABLE "user_avatars" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"mime" text NOT NULL,
	"data" "bytea" NOT NULL,
	"version" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_avatars" ADD CONSTRAINT "user_avatars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- รูปโปรไฟล์: เจ้าของแก้ของตัวเองได้ (เหมือน user_identities) · หน้า /avatars อ่านผ่าน friday_system เพราะคนอื่นในทีมต้องเห็นรูป
ALTER TABLE public.user_avatars ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY own_rows ON public.user_avatars TO friday_app
  USING (user_id = (SELECT app.user_id()))
  WITH CHECK (user_id = (SELECT app.user_id()));
