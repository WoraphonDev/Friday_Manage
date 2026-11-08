import { ReportsView } from "./_components/reports-view";

export default async function Page({ params }: { params: Promise<{ ws: string; key: string }> }) {
  const { ws, key } = await params;
  return <ReportsView ws={ws} projectKey={key} />;
}
