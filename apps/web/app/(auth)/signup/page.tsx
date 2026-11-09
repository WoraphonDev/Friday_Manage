import { Suspense } from "react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { SignupForm } from "./_components/signup-form";

// ชื่อแท็บตามภาษาของคำขอ (W21)
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.auth");
  return { title: t("signup") };
}

export default function Page() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
