import { redirect } from "next/navigation";

// ภาพรวม Lead (O1) รวมเข้า Overview แล้ว · ลิงก์เดิมพาไปส่วนแผนทั้งโปรเจกต์
export default async function Page({ params }: { params: Promise<{ ws: string; key: string }> }) {
  const { ws, key } = await params;
  redirect(`/w/${encodeURIComponent(ws)}/p/${encodeURIComponent(key)}#planning`);
}
