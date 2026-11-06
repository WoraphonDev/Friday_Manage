import { WorkspaceMembers } from "./_components/workspace-members";

export default async function Page({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  return <WorkspaceMembers ws={ws} />;
}
