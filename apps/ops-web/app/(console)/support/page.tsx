import { Suspense } from "react";
import { LoadingState } from "@/components/ui";
import { SupportPage } from "./SupportPage";

export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <SupportPage />
    </Suspense>
  );
}
