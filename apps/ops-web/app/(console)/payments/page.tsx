import { Suspense } from "react";
import { LoadingState } from "@/components/ui";
import { BillingPage } from "./BillingPage";

export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <BillingPage />
    </Suspense>
  );
}
