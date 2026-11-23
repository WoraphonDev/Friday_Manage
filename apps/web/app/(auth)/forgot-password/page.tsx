import { Suspense } from "react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CookieConsent } from "../../(public)/_components/cookie-consent";
import { ForgotPasswordFlow } from "./_components/forgot-password-flow";

// ชื่อแท็บตามภาษาของคำขอ (W21)
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.auth");
  return { title: t("forgotPassword") };
}

export default function Page() {
  return (
    <>
      <Suspense>
        <ForgotPasswordFlow />
      </Suspense>
      {/* คนที่ลงตรงหน้านี้จากโฆษณาต้องยินยอมคุกกี้วิเคราะห์ได้ ไม่งั้นไม่ได้ที่มา (A34) */}
      <CookieConsent />
    </>
  );
}
