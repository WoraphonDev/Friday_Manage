import { Suspense } from "react";
import { LoadingState } from "@/components/ui";
import { RestorePage } from "./RestorePage";

export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RestorePage />
    </Suspense>
  );
}
