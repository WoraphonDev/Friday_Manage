import { Suspense } from "react";
import type { Metadata } from "next";
import common from "../../../messages/th/common.json";
import { ForgotPasswordFlow } from "./_components/forgot-password-flow";

export const metadata: Metadata = { title: common.auth.forgotPassword };

export default function Page() {
  return (
    <Suspense>
      <ForgotPasswordFlow />
    </Suspense>
  );
}
