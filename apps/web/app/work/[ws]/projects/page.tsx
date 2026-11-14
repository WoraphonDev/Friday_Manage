import { ProjectsPage } from "./_components/projects-page";

// W29+ · รายการโปรเจกต์สำหรับแท็บ "โปรเจกต์" ของเมนูล่างมือถือ (ต้นแบบ u.projects) · desktop ใช้ Sidebar แทน
export default async function Page({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  return <ProjectsPage ws={ws} />;
}
