import { BacklogView } from "./_components/backlog-view";

export default async function Page({ params }: { params: Promise<{ ws: string; key: string }> }) {
  const { ws, key } = await params;
  return <BacklogView ws={ws} projectKey={key} />;
}
