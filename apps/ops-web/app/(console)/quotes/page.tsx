import { Suspense } from "react";
import { LoadingState } from "@/components/ui";
import { QuotesPage } from "./QuotesPage";

export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <QuotesPage />
    </Suspense>
  );
}
