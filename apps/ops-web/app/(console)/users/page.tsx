import { Suspense } from "react";
import { LoadingState } from "@/components/ui";
import { UsersPage } from "./UsersPage";

export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <UsersPage />
    </Suspense>
  );
}
