import { Suspense } from "react";
import { LoadingState } from "@/components/ui";
import { AbusePage } from "./AbusePage";

export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <AbusePage />
    </Suspense>
  );
}
