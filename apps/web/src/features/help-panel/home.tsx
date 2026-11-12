"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Bell, BookOpen, ChevronRight, CreditCard, Download, Folder, LineChart, ListChecks, Terminal, User, type LucideIcon } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui";
import { useContactSupport, useSlaText, type ContactWorkspace } from "./contact";
import { SearchBox, SearchResults, useDebounced } from "./search";
import { helpApi, helpKeys, type ArticleList, type HelpArticleSummary, type HelpCategory } from "./shared";
import styles from "./help.module.css";

const ICONS: Record<string, LucideIcon> = {
  "getting-started": ListChecks,
  "projects-issues": Folder,
  "gantt-planning": LineChart,
  "import-export": Download,
  notifications: Bell,
  "members-permissions": User,
  billing: CreditCard,
  "api-integrations": Terminal,
};
export const categoryIcon = (slug: string) => ICONS[slug] ?? BookOpen;

/** กำลังพิมพ์ในช่องกรอก (คีย์ลัดตัวอักษรต้องไม่ทำงาน) */
export const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

export function ArticleRow({ article, href, onClick }: { article: HelpArticleSummary; href: string; onClick?: () => void }) {
  const t = useTranslations("help.home");
  return (
    <Link href={href} className={styles.articleRow} onClick={onClick}>
      <span>
        <strong>{article.title}</strong>
        <small>{article.category ? t("articleMeta", { category: article.category.name, minutes: article.readMinutes }) : null}</small>
      </span>
      <ChevronRight size={16} aria-hidden="true" />
    </Link>
  );
}

/**
 * X1 / X2 · หน้าศูนย์ช่วยเหลือ · ในแอปมีการ์ดติดต่อ Support (ซ่อนจาก Guest) · หน้าสาธารณะชวนเข้าสู่ระบบแทน
 * `?category=` = ดูบทความในหมวด · `?q=` = เปิดมาพร้อมคำค้น
 */
export function HelpHome({ base, workspace, initial, publicOnly = false }: { base: string; workspace?: ContactWorkspace; initial?: { categories?: HelpCategory[]; popular?: ArticleList }; publicOnly?: boolean }) {
  const t = useTranslations("help");
  const params = useSearchParams();
  const sla = useSlaText();
  const category = params.get("category");
  const [query, setQuery] = useState(params.get("q") ?? "");
  const q = useDebounced(query);
  const searchRef = useRef<HTMLInputElement>(null);
  const categories = useQuery({ queryKey: helpKeys.categories, queryFn: helpApi.categories, initialData: initial?.categories ? { items: initial.categories } : undefined });
  const popular = useQuery({ queryKey: helpKeys.list("popular:5"), queryFn: () => helpApi.articles({ sort: "popular", limit: 5 }), initialData: initial?.popular, enabled: !category });
  const inCategory = useQuery({ queryKey: helpKeys.list(`category:${category}`), queryFn: () => helpApi.articles({ category: category!, sort: "title", limit: 50 }), enabled: !!category });
  const tickets = useQuery({ queryKey: helpKeys.tickets(workspace?.slug ?? "", "mine"), queryFn: () => helpApi.tickets(workspace!.slug, "mine"), enabled: !!workspace && workspace.role !== "guest" });
  const contact = useContactSupport(workspace ?? { slug: "", name: "", role: "guest" });
  const canContact = !!workspace && workspace.role !== "guest" && tickets.data?.canContact !== false;
  const href = (slug: string) => `${base}/${encodeURIComponent(slug)}`;
  // หน้าสาธารณะไม่แสดงบทความเฉพาะผู้เข้าสู่ระบบ แม้ผู้เปิดจะล็อกอินอยู่ (คุกกี้ส่งไปด้วย)
  const visible = (items: HelpArticleSummary[]) => (publicOnly ? items.filter((a) => a.visibility !== "signed_in") : items);

  // "/" = ไปที่ช่องค้นหา (ไม่ทำงานขณะพิมพ์)
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      event.preventDefault();
      searchRef.current?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const ask = (searchQuery?: string) => contact.open(searchQuery ? { searchQuery, page: t("title"), path: base } : { page: t("title"), path: base });
  const currentCategory = categories.data?.items.find((c) => c.slug === category);
  const s = sla(tickets.data?.sla.first);

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <h1>{t("title")}</h1>
        <p className="muted">{t("home.subtitle")}</p>
        <SearchBox value={query} onChange={setQuery} hint inputRef={searchRef} />
        <div className={styles.chips}>
          <span className="muted">{t("home.frequent")}</span>
          {(["chip1", "chip2", "chip3", "chip4"] as const).map((k) => (
            <button key={k} type="button" className={styles.chip} onClick={() => setQuery(t(`home.${k}`))}>
              {t(`home.${k}`)}
            </button>
          ))}
        </div>
      </section>

      {q.trim() ? (
        <section className={styles.card}>
          <SearchResults query={q} articleHref={href} publicOnly={publicOnly} onAsk={canContact ? (v) => ask(v) : undefined} />
        </section>
      ) : (
        <>
          {categories.isPending ? (
            <LoadingState />
          ) : categories.error ? (
            <ErrorState error={categories.error} retry={() => void categories.refetch()} />
          ) : (
            <nav className={styles.categories} aria-label={t("home.categories")}>
              {categories.data.items.map((c) => {
                const Icon = categoryIcon(c.slug);
                return (
                  <Link key={c.id} href={`${base}?category=${encodeURIComponent(c.slug)}`} className={styles.category} aria-current={c.slug === category ? "page" : undefined}>
                    <span className={styles.categoryIcon} aria-hidden="true">
                      <Icon size={18} />
                    </span>
                    <span>
                      <strong>{c.name}</strong>
                      <small>{t("home.articleCount", { count: c.articles })}</small>
                    </span>
                  </Link>
                );
              })}
            </nav>
          )}
          <div className={styles.columns}>
            <section className={styles.card}>
              <div className={styles.cardHead}>
                <h2>{category ? (currentCategory?.name ?? category) : t("home.popular")}</h2>
                {category && (
                  <Link href={base} className={styles.smallLink}>
                    {t("home.allCategories")}
                  </Link>
                )}
              </div>
              {category ? (
                inCategory.isPending ? (
                  <LoadingState />
                ) : inCategory.error ? (
                  <ErrorState error={inCategory.error} retry={() => void inCategory.refetch()} />
                ) : visible(inCategory.data.items).length ? (
                  visible(inCategory.data.items).map((a) => <ArticleRow key={a.id} article={a} href={href(a.slug)} />)
                ) : (
                  <EmptyState title={t("home.categoryEmpty")} description="" />
                )
              ) : popular.isPending ? (
                <LoadingState />
              ) : popular.error ? (
                <ErrorState error={popular.error} retry={() => void popular.refetch()} />
              ) : visible(popular.data.items).length ? (
                visible(popular.data.items).map((a) => <ArticleRow key={a.id} article={a} href={href(a.slug)} />)
              ) : (
                <EmptyState title={t("home.popularEmpty")} description="" />
              )}
            </section>
            <aside className={styles.aside}>
              <section className={styles.card}>
                <div className={styles.stuck}>
                  <h2>{t("home.stuckTitle")}</h2>
                  {!workspace ? (
                    <>
                      <p className="muted">{t("public.contactHint")}</p>
                      <Link className="button button-primary" href="/login">
                        {t("public.login")}
                      </Link>
                    </>
                  ) : canContact ? (
                    <>
                      <p className="muted">{s && tickets.data ? t("home.stuckSla", { ...s, plan: tickets.data.plan.name ?? tickets.data.plan.code }) : t("home.stuckNoSla")}</p>
                      <button type="button" className="button button-primary" onClick={() => ask()}>
                        {t("home.contact")}
                      </button>
                      <Link className={styles.smallLink} href={`${base}/tickets`}>
                        {t("home.myTickets", { count: tickets.data?.openMine ?? 0 })}
                      </Link>
                    </>
                  ) : (
                    <p className="muted">{t("home.guestHint")}</p>
                  )}
                </div>
              </section>
              <section className={`${styles.card} ${styles.statusRow}`}>
                <span className={styles.statusDot} aria-hidden="true" />
                <span>{t("home.statusOk")}</span>
              </section>
            </aside>
          </div>
        </>
      )}
      {contact.element}
    </div>
  );
}
