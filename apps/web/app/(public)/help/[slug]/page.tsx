import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PublicArticle } from "../_components/public-help";
import { fetchArticle } from "../_components/server";

// SEO: ชื่อบทความ + สรุปเป็นคำอธิบาย · canonical ชี้หน้าสาธารณะ (หน้าในแอปเนื้อหาเดียวกัน)
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const t = await getTranslations("help.public");
  const data = await fetchArticle(decodeURIComponent(slug));
  if (!data || data === "missing") return { title: t("title") };
  const { article } = data;
  const description = article.summary ?? t("description");
  return {
    title: article.title,
    description,
    alternates: { canonical: `/help/${article.slug}` },
    openGraph: { title: article.title, description, type: "article", modifiedTime: article.updatedAt },
  };
}

/** หน้าสาธารณะ /help/{slug} · บทความเฉพาะผู้เข้าสู่ระบบตอบ 404 (API ไม่ส่งให้คำขอที่ไม่มีคุกกี้) */
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const decoded = decodeURIComponent(slug);
  const data = await fetchArticle(decoded);
  if (data === "missing") notFound();
  return <PublicArticle slug={decoded} initial={data} />;
}
