import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { HelpHomeRoute } from "./_components/routes";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("help");
  return { title: t("title") };
}

/** X1 / X2 · ศูนย์ช่วยเหลือในแอป */
export default function Page() {
  return <HelpHomeRoute />;
}
