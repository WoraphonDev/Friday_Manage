import { DiagramListPage } from "@/features/diagrams/diagram-list";

export default async function Page({ params }: { params: Promise<{ ws: string; key: string }> }) {
  const { ws, key } = await params;
  return <DiagramListPage ws={ws} projectKey={key} />;
}
