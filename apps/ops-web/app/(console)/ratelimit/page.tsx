import { Suspense } from "react";
import { LoadingState } from "@/components/ui";
import { RateLimitPage } from "./RateLimitPage";

export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RateLimitPage />
    </Suspense>
  );
}
