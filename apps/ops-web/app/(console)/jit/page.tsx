import { Suspense } from "react";
import { LoadingState } from "@/components/ui";
import { JitPage } from "./JitPage";

export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <JitPage />
    </Suspense>
  );
}
