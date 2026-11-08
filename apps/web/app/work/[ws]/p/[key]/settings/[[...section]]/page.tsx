import { ProjectSettings } from "../_components/project-settings";

export default async function Page({ params }: { params: Promise<{ ws: string; key: string; section?: string[] }> }) {
  const { ws, key, section } = await params;
  // /settings/a/b ไม่มีหน้า · ส่งค่าที่ไม่รู้จักให้ component แสดง NotFound
  return <ProjectSettings ws={ws} projectKey={key} section={section && (section.length === 1 ? section[0] : section.join("/"))} />;
}
