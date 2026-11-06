import { Suspense } from "react";
import { LoadingState } from "@/components/ui";
import { Workspaces } from "@/features/workspaces/Workspaces";

export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <Workspaces />
    </Suspense>
  );
}
