import { redirect } from "next/navigation";

/**
 * ที่อยู่เดิมของหน้า Import / Export (ลิงก์ / บุ๊กมาร์กเก่า)
 * ?project=KEY → Popup Import / Export ในแท็บ Table ของโปรเจกต์ · ไม่มีโปรเจกต์ → สร้างโปรเจกต์ใหม่จาก Excel
 */
export default async function Page({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ project?: string; section?: string }> }) {
  const { ws } = await params;
  const { project, section } = await searchParams;
  const base = `/w/${encodeURIComponent(ws)}`;
  if (project) redirect(`${base}/p/${encodeURIComponent(project)}/table?io=${section === "export" ? "export" : "import"}`);
  redirect(`${base}/new-project/excel`);
}
