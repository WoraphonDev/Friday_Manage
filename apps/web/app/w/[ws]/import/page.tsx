import { redirect } from "next/navigation";

/**
 * ที่อยู่เดิมของหน้า Import / Export (ลิงก์ / บุ๊กมาร์กเก่า)
 * ?project=KEY → หน้า Import / Export ของโปรเจกต์ · ไม่มีโปรเจกต์ → สร้างโปรเจกต์ใหม่จาก Excel
 */
export default async function Page({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ project?: string; section?: string }> }) {
  const { ws } = await params;
  const { project, section } = await searchParams;
  const base = `/w/${encodeURIComponent(ws)}`;
  if (project) redirect(`${base}/p/${encodeURIComponent(project)}/import${section === "export" ? "?section=export" : ""}`);
  redirect(`${base}/new-project/excel`);
}
