import { DiagramEditorPage } from "@/features/diagrams/diagram-editor";

export default async function Page({ params }: { params: Promise<{ ws: string; key: string; id: string }> }) {
  const { ws, key, id } = await params;
  return <DiagramEditorPage ws={ws} projectKey={key} id={id} />;
}
