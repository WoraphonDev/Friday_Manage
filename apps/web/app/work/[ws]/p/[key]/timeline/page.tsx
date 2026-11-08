import { TimelineView } from "./_components/timeline-view";

export default async function Page({ params }: { params: Promise<{ ws: string; key: string }> }) {
  const { ws, key } = await params;
  return <TimelineView ws={ws} projectKey={key} />;
}
