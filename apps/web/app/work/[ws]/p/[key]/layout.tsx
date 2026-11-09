import { Suspense } from "react";
import { ProjectShell } from "@/components/shell/project-shell";
import { LoadingState } from "@/components/ui";
export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ ws: string; key: string }>;
}) {
  const { key } = await params;
  return (
    <Suspense fallback={<LoadingState />}>
      <ProjectShell projectKey={key}>{children}</ProjectShell>
    </Suspense>
  );
}
