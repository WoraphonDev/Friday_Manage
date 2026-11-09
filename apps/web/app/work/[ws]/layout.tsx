import { WorkspaceShell } from "@/components/shell/workspace-shell";
export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ ws: string }>;
}) {
  const { ws } = await params;
  return <WorkspaceShell ws={ws}>{children}</WorkspaceShell>;
}
