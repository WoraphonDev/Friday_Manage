import { Suspense } from "react";
import { LoadingState } from "@/components/ui";
import { StaffPage } from "./StaffPage";

export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <StaffPage />
    </Suspense>
  );
}
