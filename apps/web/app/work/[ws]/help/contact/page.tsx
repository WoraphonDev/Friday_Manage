import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ContactRoute } from "../_components/routes";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("help.contact");
  return { title: t("title") };
}

/** X5 มือถือ · ฟอร์มติดต่อทีม Support เต็มจอ */
export default function Page() {
  return <ContactRoute />;
}
