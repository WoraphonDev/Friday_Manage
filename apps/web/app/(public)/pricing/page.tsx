import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PricingPage } from "../_components/landing";

// ชื่อแท็บตามภาษาของคำขอ (W21)
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("saas-pages.pricing");
  return { title: t("title") };
}

export default function Page() {
  return <PricingPage />;
}
