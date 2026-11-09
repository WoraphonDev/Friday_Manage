import { Suspense } from "react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LoginForm } from "./_components/login-form";

// ชื่อแท็บตามภาษาของคำขอ (W21)
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.auth");
  return { title: t("login") };
}

// useSearchParams ต้องอยู่ใต้ Suspense เพื่อให้ build แบบ static ได้
export default function Page() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
