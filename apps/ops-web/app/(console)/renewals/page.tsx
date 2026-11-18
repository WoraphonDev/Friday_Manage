import { Suspense } from "react";
import { LoadingState } from "@/components/ui";
import { RenewalsPage } from "./RenewalsPage";

export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RenewalsPage />
    </Suspense>
  );
}
