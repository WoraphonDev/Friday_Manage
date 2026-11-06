import { Suspense } from "react";
import type { Metadata } from "next";
import common from "../../../messages/th/common.json";
import { SignupForm } from "./_components/signup-form";

export const metadata: Metadata = { title: common.auth.signup };

export default function Page() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
