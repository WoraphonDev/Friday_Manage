import { KanbanPage } from "./_components/kanban-page";

export default async function Page({ params }: { params: Promise<{ ws: string; key: string }> }) {
  const { ws, key } = await params;
  return <KanbanPage ws={ws} projectKey={key} />;
}
