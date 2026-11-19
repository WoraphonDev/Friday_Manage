import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ContactSalesPage } from "../_components/contact-sales";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("saas-pages.contactSales");
  return { title: t("title") };
}

export default function Page() {
  return <ContactSalesPage />;
}
