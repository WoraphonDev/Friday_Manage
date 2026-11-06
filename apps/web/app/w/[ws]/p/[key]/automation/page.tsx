import { AutomationPage } from "./_components/automation-page";

export default async function Page({ params }: { params: Promise<{ ws: string; key: string }> }) {
  const { ws, key } = await params;
  return <AutomationPage ws={ws} projectKey={key} />;
}
