"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { LoadingState } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { ArticleView } from "@/features/help-panel/article";
import { ContactForm, type ContactPrefill } from "@/features/help-panel/contact";
import { HelpHome } from "@/features/help-panel/home";
import { TicketsPage } from "@/features/help-panel/tickets";
import styles from "@/features/help-panel/help.module.css";

/** ข้อมูล Workspace ปัจจุบันจาก shell (บทบาทใช้ซ่อนปุ่มติดต่อ Support ของ Guest) */
function useCurrent() {
  const { workspace } = useWorkspace();
  return { slug: workspace.slug, name: workspace.name, role: workspace.role };
}
const base = (ws: string) => `/work/${encodeURIComponent(ws)}/help`;

export function HelpHomeRoute() {
  const workspace = useCurrent();
  return (
    <Suspense fallback={<LoadingState />}>
      <HelpHome base={base(workspace.slug)} workspace={workspace} />
    </Suspense>
  );
}

export function ArticleRoute({ slug }: { slug: string }) {
  const workspace = useCurrent();
  return (
    <div className={styles.page}>
      <ArticleView slug={slug} base={base(workspace.slug)} workspace={workspace} />
    </div>
  );
}

export function TicketsRoute() {
  const workspace = useCurrent();
  return (
    <Suspense fallback={<LoadingState />}>
      <TicketsPage workspace={workspace} />
    </Suspense>
  );
}

function Contact() {
  const t = useTranslations("help");
  const workspace = useCurrent();
  const router = useRouter();
  const params = useSearchParams();
  const prefill: ContactPrefill = {};
  for (const key of ["articleSlug", "articleTitle", "searchQuery", "subject", "page", "path"] as const) {
    const v = params.get(key);
    if (v) prefill[key] = v;
  }
  const back = () => router.push(base(workspace.slug));
  return (
    <div className={styles.page}>
      <section className={styles.card}>
        <div className={styles.contactPage}>
          <h1>{t("contact.title")}</h1>
          {workspace.role === "guest" ? <p className="muted">{t("home.guestHint")}</p> : <ContactForm workspace={workspace} prefill={prefill} onDone={back} onCancel={back} />}
        </div>
      </section>
    </div>
  );
}

/** X5 มือถือ: ฟอร์มติดต่อ Support เต็มจอ (เดสก์ท็อปเปิดเป็น Dialog จากหน้าเดิม) */
export function ContactRoute() {
  return (
    <Suspense fallback={<LoadingState />}>
      <Contact />
    </Suspense>
  );
}
