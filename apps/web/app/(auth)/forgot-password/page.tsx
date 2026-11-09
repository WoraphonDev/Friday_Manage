import { Suspense } from "react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ForgotPasswordFlow } from "./_components/forgot-password-flow";

// ชื่อแท็บตามภาษาของคำขอ (W21)
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.auth");
  return { title: t("forgotPassword") };
}

export default function Page() {
  return (
    <Suspense>
      <ForgotPasswordFlow />
    </Suspense>
  );
}
