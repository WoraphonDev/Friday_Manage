import { PlanChangesView } from "./_components/plan-changes-view";

export default async function Page({ params }: { params: Promise<{ ws: string; key: string }> }) {
  const { ws, key } = await params;
  return <PlanChangesView ws={ws} projectKey={key} />;
}
