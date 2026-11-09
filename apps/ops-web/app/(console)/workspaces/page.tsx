import { Suspense } from "react";
import { LoadingState } from "@/components/ui";
import { WorkspacesList } from "./WorkspacesList";

export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <WorkspacesList />
    </Suspense>
  );
}
