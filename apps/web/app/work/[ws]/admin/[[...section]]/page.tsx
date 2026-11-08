import { AdminConsole } from "../_components/admin-console";

export default async function Page({ params }: { params: Promise<{ ws: string; section?: string[] }> }) {
  const { ws, section } = await params;
  // /admin/a/b ไม่มีหน้า · ส่งค่าที่ไม่รู้จักให้ component แสดง NotFound
  return <AdminConsole ws={ws} section={section && (section.length === 1 ? section[0] : section.join("/"))} />;
}
