import { redirect } from "next/navigation";

/** ที่อยู่เดิมของ Import / Export ในโปรเจกต์ → Popup ในแท็บ Table (ผู้ใช้ตัดสิน 2026-11-09) */
export default async function Page({ params, searchParams }: { params: Promise<{ ws: string; key: string }>; searchParams: Promise<{ section?: string }> }) {
  const { ws, key } = await params;
  const { section } = await searchParams;
  redirect(`/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(key)}/table?io=${section === "export" ? "export" : "import"}`);
}
