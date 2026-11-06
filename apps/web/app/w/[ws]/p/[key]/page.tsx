import { OverviewPage } from "./table/_components/overview";

export default async function Page({ params }: { params: Promise<{ ws: string; key: string }> }) {
  const { ws, key } = await params;
  return <OverviewPage ws={ws} projectKey={key} />;
}
