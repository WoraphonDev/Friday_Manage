import { Suspense } from "react";
import { LoadingState } from "@/components/ui";
import { ScriptsPage } from "./ScriptsPage";

export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <ScriptsPage />
    </Suspense>
  );
}
