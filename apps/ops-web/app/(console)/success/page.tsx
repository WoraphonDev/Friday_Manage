import { Suspense } from "react";
import { LoadingState } from "@/components/ui";
import { SuccessPage } from "./SuccessPage";

export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <SuccessPage />
    </Suspense>
  );
}
