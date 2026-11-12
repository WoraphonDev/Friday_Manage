import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PublicHelpHome } from "./_components/public-help";
import { fetchCategories, fetchPopular } from "./_components/server";

// SEO: ชื่อและคำอธิบายของหน้าศูนย์ช่วยเหลือสาธารณะ (คำตัดสิน W26 · ช่องทางบทความ / SEO)
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("help.public");
  return { title: t("title"), description: t("description"), alternates: { canonical: "/help" }, openGraph: { title: t("title"), description: t("description"), type: "website" } };
}

/** หน้าสาธารณะ /help (เนื้อหาเดียวกับ X1 ใช้หัว Landing) */
export default async function Page() {
  const [categories, popular] = await Promise.all([fetchCategories(), fetchPopular()]);
  return <PublicHelpHome categories={categories?.items ?? null} popular={popular} />;
}
