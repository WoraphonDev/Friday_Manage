import { Suspense } from "react";
import { LoadingState } from "@/components/ui";
import { HelpPage } from "./HelpPage";

export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <HelpPage />
    </Suspense>
  );
}
