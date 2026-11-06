import { LeadDashboard } from "./_components/lead-dashboard";

export default async function Page({ params }: { params: Promise<{ ws: string; key: string }> }) {
  const { ws, key } = await params;
  return <LeadDashboard ws={ws} projectKey={key} />;
}
