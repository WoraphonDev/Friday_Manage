"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import { Button, ErrorState } from "@/components/ui";
import { Highlight } from "./markdown";
import { helpApi, helpKeys } from "./shared";
import styles from "./help.module.css";

/** หน่วงคำค้นก่อนยิง API (พิมพ์แล้วแสดงผลทันทีที่หยุด 250 ms ตาม X1) */
export function useDebounced(value: string, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setV(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return v;
}

export function SearchBox({ value, onChange, autoFocus, hint, inputRef, compact }: { value: string; onChange: (v: string) => void; autoFocus?: boolean; hint?: boolean; inputRef?: React.Ref<HTMLInputElement>; compact?: boolean }) {
  const t = useTranslations("help.home");
  return (
    <label className={compact ? `${styles.searchBox} ${styles.searchCompact}` : styles.searchBox}>
      <Search size={18} aria-hidden="true" />
      <input ref={inputRef} type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={t("searchPlaceholder")} aria-label={t("searchLabel")} autoFocus={autoFocus} />
      {hint && <kbd aria-hidden="true">/</kbd>}
    </label>
  );
}

/**
 * ผลค้นหาบทความ (X2) · ไฮไลต์คำที่ตรง · ไม่พบ = ชวนถามทีม Support พร้อมคำค้น
 * `articleHref` ต่างกันระหว่างในแอป (/work/{ws}/help/…) กับหน้าสาธารณะ (/help/…)
 */
export function SearchResults({ query, articleHref, onAsk, onNavigate, publicOnly = false }: { query: string; articleHref: (slug: string) => string; onAsk?: (q: string) => void; onNavigate?: () => void; publicOnly?: boolean }) {
  const t = useTranslations("help.results");
  const q = query.trim();
  const results = useQuery({ queryKey: helpKeys.list(`q:${q}`), queryFn: () => helpApi.articles({ q, limit: 20 }), enabled: q.length > 0 });
  if (results.isPending) return <p className={styles.searching} aria-busy="true">{t("searching")}</p>;
  if (results.error) return <ErrorState error={results.error} retry={() => void results.refetch()} />;
  const items = publicOnly ? results.data.items.filter((a) => a.visibility !== "signed_in") : results.data.items;
  const data = { ...results.data, items, total: publicOnly ? items.length : results.data.total };
  if (!data.items.length)
    return (
      <div className={styles.miss}>
        <span className={styles.missIcon} aria-hidden="true">
          <Search size={18} />
        </span>
        <h3>{t("emptyTitle", { q })}</h3>
        <p className="muted">{t("emptyHint")}</p>
        {onAsk && (
          <Button variant="primary" onClick={() => onAsk(q)}>
            {t("ask")}
          </Button>
        )}
        <p className={styles.missNote}>{t("missNote")}</p>
      </div>
    );
  return (
    <div className={styles.results}>
      {data.partial && <p className={styles.partial}>{t("partial")}</p>}
      <ul aria-label={t("count", { count: data.total })}>
        {data.items.map((a) => (
          <li key={a.id}>
            <Link href={articleHref(a.slug)} className={styles.result} onClick={onNavigate}>
              {a.category && <span className={styles.resultCat}>{a.category.name}</span>}
              <strong>
                <Highlight text={a.title} terms={data.terms} />
              </strong>
              {a.snippet && (
                <span className={styles.snippet}>
                  <Highlight text={a.snippet} terms={data.terms} />
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
      <p className={styles.resultsFoot}>
        {t("count", { count: data.total })}
        {onAsk && (
          <>
            {" · "}
            <button type="button" className={styles.linkButton} onClick={() => onAsk(q)}>
              {t("notFound")} {t("contact")}
            </button>
          </>
        )}
      </p>
    </div>
  );
}
