// หน้าสาธารณะ /help ดึงข้อมูลฝั่ง server เพื่อให้เนื้อหาอยู่ใน HTML ตั้งแต่แรก (SEO) · ไม่ส่งคุกกี้ = เห็นเฉพาะบทความ "ทุกคน"
// เรียก API ไม่ได้ (เช่น container ไม่มี API_ORIGIN ตอนรัน) = คืน null แล้วให้หน้าเว็บโหลดเองฝั่ง browser
import { cache } from "react";
import type { ArticleDetail, ArticleList, HelpCategory } from "@/features/help-panel/shared";

const origin = () => (process.env.API_ORIGIN ?? "http://127.0.0.1:3001").replace(/\/$/, "");

/** "missing" = API ตอบ 404 (ไม่มีบทความ / ยังไม่เผยแพร่ / เฉพาะผู้เข้าสู่ระบบ) ให้หน้าตอบ 404 จริงสำหรับเครื่องมือค้นหา */
async function get<T>(path: string): Promise<T | "missing" | null> {
  try {
    const response = await fetch(`${origin()}/api/v1${path}`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    if (response.status === 404) return "missing";
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

const ok = <T>(v: T | "missing" | null) => (v === "missing" ? null : v);
export const fetchCategories = async () => ok(await get<{ items: HelpCategory[] }>("/help/categories"));
export const fetchPopular = async () => ok(await get<ArticleList>("/help/articles?sort=popular&limit=5"));
// generateMetadata กับหน้าเรียกซ้ำในคำขอเดียว · cache กันยิงซ้ำ (และไม่นับยอดอ่านซ้ำ)
export const fetchArticle = cache((slug: string) => get<ArticleDetail>(`/help/articles/${encodeURIComponent(slug)}`));
