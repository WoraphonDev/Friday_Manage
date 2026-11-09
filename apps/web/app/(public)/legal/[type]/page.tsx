import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { LegalView } from "../../_components/legal";
import { isLegalType } from "../../_components/legal-types";

export async function generateMetadata({ params }: { params: Promise<{ type: string }> }): Promise<Metadata> {
  const { type } = await params;
  const t = await getTranslations("saas-pages.legal");
  return { title: isLegalType(type) ? t(`types.${type}`) : t("center") };
}

export default async function Page({ params }: { params: Promise<{ type: string }> }) {
  const { type } = await params;
  if (!isLegalType(type)) notFound();
  return <LegalView type={type} />;
}
