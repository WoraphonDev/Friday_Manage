"use client";

import { useContext, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { FileQuestion, ThumbsDown, ThumbsUp } from "lucide-react";
import { Badge, Button, ErrorState, LoadingState, YearFormatContext } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useContactSupport, type ContactWorkspace } from "./contact";
import { ArticleBody, tocOf } from "./markdown";
import { helpApi, helpKeys, type ArticleDetail } from "./shared";
import styles from "./help.module.css";

/**
 * X3 · หน้าบทความ (ในแอปและหน้าสาธารณะ) · สารบัญจากหัวข้อระดับ 2 · โหวตช่วยได้ / ไม่ช่วย
 * ลิงก์ `app:/…` ในบทความพาไปหน้าจริงของ Workspace ปัจจุบัน (หน้าสาธารณะพาไปเข้าสู่ระบบ)
 */
export function ArticleView({ slug, base, workspace, initial, publicOnly = false }: { slug: string; base: string; workspace?: ContactWorkspace; initial?: ArticleDetail; publicOnly?: boolean }) {
  const t = useTranslations("help");
  const year = useContext(YearFormatContext);
  const data = useQuery({ queryKey: helpKeys.article(slug), queryFn: () => helpApi.article(slug), initialData: initial, retry: false });
  const contact = useContactSupport(workspace ?? { slug: "", name: "", role: "guest" });
  const canContact = !!workspace && workspace.role !== "guest";
  const [vote, setVote] = useState<"yes" | "no" | null>(null);
  const [comment, setComment] = useState("");
  const [done, setDone] = useState(false);
  const feedback = useMutation({
    mutationFn: (body: { helpful: boolean; comment?: string }) => helpApi.feedback(slug, body),
    onSuccess: () => setDone(true),
  });

  if (data.isPending) return <LoadingState />;
  // หน้าสาธารณะไม่แสดงบทความเฉพาะผู้เข้าสู่ระบบ แม้ผู้เปิดจะล็อกอินอยู่
  const hidden = publicOnly && data.data?.article.visibility === "signed_in";
  if (data.error || hidden) {
    if (hidden || (data.error instanceof ApiError && data.error.status === 404))
      return (
        <section className="state">
          <span className="state-icon" aria-hidden="true">
            <FileQuestion />
          </span>
          <h2>{t("article.notFound")}</h2>
          <p className="muted">{t("article.notFoundHint")}</p>
          <Link className="button" href={base}>
            {t("title")}
          </Link>
        </section>
      );
    return <ErrorState error={data.error} retry={() => void data.refetch()} />;
  }
  const article = data.data.article;
  const related = publicOnly ? data.data.related.filter((r) => r.visibility !== "signed_in") : data.data.related;
  const toc = tocOf(article.body);
  const appBase = workspace ? `/work/${encodeURIComponent(workspace.slug)}` : null;
  const attach = () => contact.open({ articleSlug: article.slug, articleTitle: article.title, page: article.title, path: `${base}/${article.slug}` });

  return (
    <div className={styles.articleLayout}>
      <article className={`${styles.card} ${styles.article}`}>
        <nav className={styles.crumbs} aria-label={t("title")}>
          <Link href={base}>{t("title")}</Link>
          {article.category && (
            <>
              <span aria-hidden="true">›</span>
              <Link href={`${base}?category=${encodeURIComponent(article.category.slug)}`}>{article.category.name}</Link>
            </>
          )}
        </nav>
        <h1>{article.title}</h1>
        <p className={styles.articleMeta}>
          {t("article.updated", { date: formatDate(article.updatedAt, year, true), minutes: article.readMinutes })}
          {article.visibility === "signed_in" && <Badge tone="purple">{t("article.signedIn")}</Badge>}
        </p>
        <ArticleBody body={article.body} appBase={appBase} />
        <section className={styles.vote} aria-label={t("article.helpfulQ")}>
          <div className={styles.voteHead}>
            <b>{t("article.helpfulQ")}</b>
            {!done && (
              <div className={styles.voteButtons}>
                <Button
                  aria-pressed={vote === "yes"}
                  disabled={feedback.isPending}
                  onClick={() => {
                    setVote("yes");
                    feedback.mutate({ helpful: true });
                  }}
                >
                  <ThumbsUp size={16} aria-hidden="true" />
                  {t("article.yes")}
                </Button>
                <Button aria-pressed={vote === "no"} onClick={() => setVote("no")}>
                  <ThumbsDown size={16} aria-hidden="true" />
                  {t("article.no")}
                </Button>
              </div>
            )}
          </div>
          {done && <p role="status" className="muted">{t("article.thanks")}</p>}
          {!done && vote === "no" && (
            <div className={styles.voteMore}>
              <div className="field">
                <label htmlFor="help-feedback">{t("article.missing")}</label>
                <textarea id="help-feedback" className="input" rows={3} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
              </div>
              <div className={styles.voteButtons}>
                <Button disabled={feedback.isPending} onClick={() => feedback.mutate({ helpful: false, ...(comment.trim() ? { comment: comment.trim() } : {}) })}>
                  {t("article.sendFeedback")}
                </Button>
                {canContact && (
                  <Button variant="primary" onClick={attach}>
                    {t("article.contactWith")}
                  </Button>
                )}
              </div>
            </div>
          )}
          {feedback.error && (
            <p className="field-error" role="alert">
              {feedback.error.message}
            </p>
          )}
        </section>
      </article>
      <aside className={styles.articleAside}>
        {toc.length > 0 && (
          <nav className={styles.card} aria-label={t("article.toc")}>
            <div className={styles.asideBox}>
              <b>{t("article.toc")}</b>
              {toc.map((h) => (
                <a key={h.id} href={`#${h.id}`}>
                  {h.text}
                </a>
              ))}
            </div>
          </nav>
        )}
        {related.length > 0 && (
          <nav className={styles.card} aria-label={t("article.related")}>
            <div className={styles.asideBox}>
              <b>{t("article.related")}</b>
              {related.map((r) => (
                <Link key={r.id} href={`${base}/${encodeURIComponent(r.slug)}`}>
                  {r.title}
                </Link>
              ))}
            </div>
          </nav>
        )}
      </aside>
      {contact.element}
    </div>
  );
}
