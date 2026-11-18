import { Suspense } from "react";
import { LoadingState } from "@/components/ui";
import { AccountsPage } from "./AccountsPage";

export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <AccountsPage />
    </Suspense>
  );
}
