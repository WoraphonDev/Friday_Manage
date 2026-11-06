import { GanttView } from "./_components/gantt-view";

export default async function Page({ params }: { params: Promise<{ ws: string; key: string }> }) {
  const { ws, key } = await params;
  return <GanttView ws={ws} projectKey={key} />;
}
