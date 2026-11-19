import { Suspense } from "react";
import { LoadingState } from "@/components/ui";
import { LeadsPage } from "./LeadsPage";

export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <LeadsPage />
    </Suspense>
  );
}
