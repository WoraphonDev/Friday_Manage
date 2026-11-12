import { Suspense } from "react";
import { ChangelogPage } from "./ChangelogPage";

export default function Page() {
  return (
    <Suspense>
      <ChangelogPage />
    </Suspense>
  );
}
