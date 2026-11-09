"use client";

import { Children, isValidElement, useState, type ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ErrorState, LoadingState } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Brand } from "./site";
import { LEGAL_TYPES, type LegalType } from "./legal-types";
import styles from "./public.module.css";

/** `GET public/legal/{type}` (A30) */
export interface LegalDocument {
  id: string;
  type: LegalType;
  version: string;
  locale: "th" | "en";
  effectiveAt: string;
  summary: string | null;
  body: string;
  versions: { version: string; effectiveAt: string }[];
}

const text = (node: ReactNode): string =>
  Children.toArray(node)
    .map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : isValidElement<{ children?: ReactNode }>(c) ? text(c.props.children) : ""))
    .join("");
/** id ของหัวข้อจากข้อความ (ใช้ทั้งในสารบัญและหัวข้อในเนื้อหา) */
export const headingId = (value: string) => `sec-${value.trim().replace(/[\s/]+/g, "-").replace(/[^\p{L}\p{N}\p{M}-]/gu, "").toLowerCase()}`;

/** R4 · ศูนย์ข้อมูลทางกฎหมาย */
export function LegalView({ type }: { type: LegalType }) {
  const t = useTranslations("saas-pages.legal");
  const [version, setVersion] = useState<string | undefined>();
  const doc = useQuery({
    queryKey: ["public-legal", type, version ?? "latest"],
    queryFn: () => api.get<LegalDocument>(`/public/legal/${type}${version ? `?version=${encodeURIComponent(version)}` : ""}`),
    retry: false,
  });
  // 404 = ยังไม่ได้ลงเอกสารจริง (A30 ไม่ใส่เนื้อหาใน seed) → แสดงโครงหัวข้อตาม Canvas แทน
  const missing = doc.error instanceof ApiError && doc.error.status === 404;

  return (
    <div className={styles.page}>
      <header className={styles.legalHeader}>
        <div className={styles.legalHeaderRow}>
          <Brand />
          <span className={styles.muted}>{t("center")}</span>
        </div>
      </header>
      <main className={styles.legalBody}>
        <nav className={styles.tabs} aria-label={t("tabs")}>
          {LEGAL_TYPES.map((k) => (
            <Link key={k} href={`/legal/${k}`} className={styles.tab} aria-current={k === type ? "page" : undefined}>
              {t(`tabLabels.${k}`)}
            </Link>
          ))}
        </nav>
        {doc.isPending ? (
          <LoadingState />
        ) : missing ? (
          <Outline type={type} />
        ) : doc.error ? (
          <ErrorState error={doc.error} retry={() => doc.refetch()} />
        ) : (
          <Document doc={doc.data} onVersion={setVersion} />
        )}
      </main>
    </div>
  );
}

function Document({ doc, onVersion }: { doc: LegalDocument; onVersion: (v: string) => void }) {
  const t = useTranslations("saas-pages.legal");
  const headings = [...doc.body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
  return (
    <div className={styles.legalRow}>
      {headings.length > 0 && (
        <nav className={styles.toc} aria-label={t("toc")}>
          <b>{t("toc")}</b>
          {headings.map((h) => (
            <a key={h} href={`#${headingId(h)}`}>
              {h}
            </a>
          ))}
        </nav>
      )}
      <article className={styles.article}>
        <div>
          <h1>{t(`types.${doc.type}`)}</h1>
          <div className={cn(styles.muted, styles.meta)}>
            <span>{t("version", { version: doc.version })}</span>·<span>{t("effective", { date: formatDate(doc.effectiveAt, "BE", true) })}</span>·
            <button type="button" className={styles.linkButton} style={{ color: "var(--primary-text)" }} onClick={() => window.print()}>
              {t("print")}
            </button>
            {doc.versions.length > 1 && (
              <>
                ·
                <label>
                  {t("history")}{" "}
                  <select value={doc.version} onChange={(e) => onVersion(e.target.value)}>
                    {doc.versions.map((v) => (
                      <option key={v.version} value={v.version}>
                        {t("versionOption", { version: v.version, date: formatDate(v.effectiveAt, "BE", true) })}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </div>
        </div>
        {doc.summary && <p>{doc.summary}</p>}
        <div className={styles.markdown}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({ children }) => <h2 id={headingId(text(children))}>{children}</h2>,
              h2: ({ children }) => <h2 id={headingId(text(children))}>{children}</h2>,
            }}
          >
            {doc.body}
          </ReactMarkdown>
        </div>
        <div className={cn(styles.muted, styles.divider)}>{t("dpo")}</div>
      </article>
    </div>
  );
}

/** ยังไม่มีเอกสารฉบับจริง: แสดงหัวข้อที่เอกสารต้องครอบคลุม (ตาม Canvas) และบอกตรง ๆ ว่ารอเนื้อหา */
function Outline({ type }: { type: LegalType }) {
  const t = useTranslations("saas-pages.legal");
  const sections = t.raw(`outline.${type}.sections`) as [string, string][];
  return (
    <>
      <div className={styles.note} role="status">
        <b>{t("pendingTitle")}</b> {t("pending")}
      </div>
      <div className={styles.legalRow}>
        <nav className={styles.toc} aria-label={t("toc")}>
          <b>{t("toc")}</b>
          {sections.map(([name], i) => (
            <a key={name} href={`#${headingId(name)}`}>
              {i + 1}. {name}
            </a>
          ))}
        </nav>
        <article className={styles.article}>
          <h1>{t(`types.${type}`)}</h1>
          <p>{t(`outline.${type}.intro`)}</p>
          {type === "subprocessors" ? (
            <div>
              <div className={cn(styles.sp, styles.spHead)}>
                <span>{t("sub.kind")}</span>
                <span>{t("sub.data")}</span>
                <span>{t("sub.vendor")}</span>
              </div>
              {(t.raw("sub.rows") as [string, string][]).map(([k, d]) => (
                <div key={k} className={styles.sp}>
                  <b>{k}</b>
                  <span>{d}</span>
                  <span className={styles.muted}>{t("sub.tbd")}</span>
                </div>
              ))}
              <p className={styles.muted} style={{ fontSize: 14, marginTop: 10 }}>
                {t("sub.notice")}
              </p>
            </div>
          ) : (
            sections.map(([name, hint], i) => (
              <section key={name} className={styles.secs} id={headingId(name)}>
                <h2>
                  {i + 1}. {name}
                </h2>
                <div className={styles.muted} style={{ fontSize: 14 }}>
                  {hint ? t("covers", { hint }) : t("waiting")}
                </div>
                <div className={styles.ph} aria-hidden="true" />
              </section>
            ))
          )}
        </article>
      </div>
    </>
  );
}
