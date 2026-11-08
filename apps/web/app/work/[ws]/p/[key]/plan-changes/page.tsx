import { redirect } from "next/navigation";

/** ที่อยู่เดิมของแท็บการแก้ไขแผน → Popup Import / Export ในแท็บ Table (ผู้ใช้ตัดสิน 2026-11-09) · ใน Settings มีเมนูเดียวกัน */
export default async function Page({ params }: { params: Promise<{ ws: string; key: string }> }) {
  const { ws, key } = await params;
  redirect(`/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(key)}/table?io=changes`);
}
