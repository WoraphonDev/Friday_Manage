import { Suspense } from "react";
import { LoadingState } from "@/components/ui";
import { IncidentsPage } from "./IncidentsPage";

export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <IncidentsPage />
    </Suspense>
  );
}
