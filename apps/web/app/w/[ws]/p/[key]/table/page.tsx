import { TableView } from "./_components/table-view";

export default async function Page({ params }: { params: Promise<{ ws: string; key: string }> }) {
  const { ws, key } = await params;
  return <TableView ws={ws} projectKey={key} />;
}
