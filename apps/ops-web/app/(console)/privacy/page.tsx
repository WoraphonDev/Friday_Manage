import { Suspense } from "react";
import { LoadingState } from "@/components/ui";
import { PrivacyPage } from "./PrivacyPage";

export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <PrivacyPage />
    </Suspense>
  );
}
