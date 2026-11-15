"use client";

import { Suspense } from "react";
import { PageEnter } from "@/components/shell/page-enter";
import { LoadingState } from "@/components/ui";
import { ArticleView } from "@/features/help-panel/article";
import { HelpHome } from "@/features/help-panel/home";
import type { ArticleDetail, ArticleList, HelpCategory } from "@/features/help-panel/shared";
import help from "@/features/help-panel/help.module.css";
import { SiteFooter, SiteHeader } from "../../_components/site";
import styles from "../../_components/public.module.css";

/**
 * หน้าสาธารณะ /help ใช้หัว Landing (R1) ไม่มี Sidebar · ไม่มีปุ่มติดต่อ Support (ชวนเข้าสู่ระบบแทน)
 * เนื้อหาจางเข้าเมื่อเปลี่ยนหน้า (PageEnter แบบหน้าในระบบ) · หัวและท้ายเว็บอยู่นอกกรอบจึงไม่ขยับ
 */
export function PublicHelpHome({ categories, popular }: { categories: HelpCategory[] | null; popular: ArticleList | null }) {
  return (
    <div className={styles.page}>
      <SiteHeader />
      <PageEnter>
        <main className={help.publicMain}>
          <Suspense fallback={<LoadingState />}>
            <HelpHome base="/help" publicOnly initial={{ categories: categories ?? undefined, popular: popular ?? undefined }} />
          </Suspense>
        </main>
      </PageEnter>
      <SiteFooter />
    </div>
  );
}

export function PublicArticle({ slug, initial }: { slug: string; initial: ArticleDetail | null }) {
  return (
    <div className={styles.page}>
      <SiteHeader />
      <PageEnter>
        <main className={help.publicMain}>
          <div className={help.page}>
            <ArticleView slug={slug} base="/help" publicOnly initial={initial ?? undefined} />
          </div>
        </main>
      </PageEnter>
      <SiteFooter />
    </div>
  );
}
