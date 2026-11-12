import { ArticleRoute } from "../_components/routes";

/** X3 · หน้าบทความในแอป · ลิงก์ app:/… ในบทความพาไปหน้าจริงของ Workspace นี้ */
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <ArticleRoute slug={decodeURIComponent(slug)} />;
}
