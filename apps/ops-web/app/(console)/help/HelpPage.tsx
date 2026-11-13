"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { hasAny } from "@/components/access";
import { Chip, Empty, ErrorBlock, Modal, Notice, PageHead, Tabs, TableSkeleton } from "@/components/kit";
import { Button, errorToast, InlineError, Input, Pill, Select, type Tone, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useFmt } from "../workspaces/_parts/format";
import { CategoriesDialog } from "./_components/CategoriesDialog";
import { FromTicketDialog } from "./_components/FromTicketDialog";
import { type Article, type ArticleRow, type Category, HELP_KEY, type Miss, type Overview } from "./_components/types";
import styles from "./help.module.css";

type Tab = "articles" | "misses" | "review";
type Filter = "all" | "published" | "draft" | "lowHelpful";

/** ช่วยได้ ≥ 70% = ดี (เกณฑ์ "ต้องทบทวน" ของ O35) */
export const helpfulTone = (pct: number | null): Tone => (pct == null ? "neu" : pct >= 70 ? "ok" : "warn");
const pctText = (n: number | null | undefined, na: string) => (n == null ? na : `${n}%`);

/** สร้างร่างแล้วเปิดตัวแก้ (ปุ่ม "เขียนบทความ" ของหัวหน้าและการ์ดคำค้นที่ไม่พบ) */
function useCreateDraft() {
  const router = useRouter();
  const toast = useToast();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (body: { title: string; categoryId: string; fromQuery?: string }) => api.post<{ article: Article }>("/help/articles", body),
    onSuccess: (r) => {
      void cache.invalidateQueries({ queryKey: HELP_KEY });
      router.push(`/help/${r.article.id}`);
    },
    onError: (e) => toast(errorToast(e)),
  });
}

/** บอร์ด 19 · ศูนย์ช่วยเหลือ: KPI · บทความ / คำค้นที่ไม่พบ / ต้องทบทวน · Owner และ Support เขียนได้ บทบาทอื่นอ่านอย่างเดียว */
export function HelpPage() {
  const t = useTranslations("help.list");
  const fmt = useFmt();
  const router = useRouter();
  const params = useSearchParams();
  const me = useMe().data;
  const writer = hasAny(me, "owner", "support");
  const [tab, setTab] = useState<Tab>("articles");
  const [filter, setFilter] = useState<Filter>("all");
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search.trim());
  const [modal, setModal] = useState<"categories" | "create" | null>(null);
  const fromTicket = params.get("fromTicket");
  const create = useCreateDraft();

  const overview = useQuery({ queryKey: [...HELP_KEY, "overview"], queryFn: () => api.get<Overview>("/help/overview") });
  const categories = useQuery({ queryKey: [...HELP_KEY, "categories"], queryFn: () => api.get<{ items: Category[] }>("/help/categories") });
  const listParams = new URLSearchParams();
  if (tab === "review") listParams.set("review", "1");
  else {
    listParams.set("status", filter === "published" || filter === "draft" ? filter : "all");
    if (filter === "lowHelpful") listParams.set("lowHelpful", "1");
    if (category) listParams.set("category", category);
    if (q) listParams.set("q", q);
  }
  const list = useQuery({
    queryKey: [...HELP_KEY, "articles", listParams.toString()],
    queryFn: () => api.get<{ items: ArticleRow[] }>(`/help/articles?${listParams}`),
    enabled: tab !== "misses",
    placeholderData: keepPreviousData,
  });
  const misses = useQuery({ queryKey: [...HELP_KEY, "misses"], queryFn: () => api.get<{ items: Miss[] }>("/help/misses?days=30"), enabled: tab === "misses" });

  const cats = categories.data?.items ?? [];
  const canEdit = writer && (overview.data?.canEdit ?? true);
  const k = overview.data?.kpi;
  const na = t("kpi.na");
  const writeFromMiss = (query: string) => {
    if (!cats.length) return create.reset(), setModal("categories");
    create.mutate({ title: query, categoryId: [...cats].sort((a, b) => a.position - b.position)[0]!.id, fromQuery: query });
  };

  const missRow = (m: Miss) =>
    m.articleId ? (
      <Link className="link-button" href={`/help/${m.articleId}`}>
        {m.articleTitle ?? t("answered")}
      </Link>
    ) : canEdit ? (
      <Button size="small" disabled={create.isPending} onClick={() => writeFromMiss(m.query)}>
        {t("writeFromMiss")}
      </Button>
    ) : null;

  return (
    <>
      <PageHead
        title={t("title")}
        desc={t("desc")}
        actions={
          canEdit && (
            <>
              <Button onClick={() => setModal("categories")} disabled={!categories.data}>
                {t("categories")}
              </Button>
              <Button variant="primary" onClick={() => setModal("create")}>
                {t("write")}
              </Button>
            </>
          )
        }
      />
      {me && !writer && <Notice tone="info" title={t("readOnly")} />}

      <section className="stats" aria-label="KPI">
        {overview.isPending ? (
          <TableSkeleton rows={1} cols={4} />
        ) : overview.error ? (
          <ErrorBlock error={overview.error} retry={() => void overview.refetch()} />
        ) : (
          k && (
            <>
              <div className="stat">
                <span className="muted small">{t("kpi.published")}</span>
                <b>{fmt.num(k.published)}</b>
                <span className="muted small">{t("kpi.publishedNote", { review: k.review, drafts: k.drafts })}</span>
              </div>
              <div className="stat">
                <span className="muted small">{t("kpi.searches")}</span>
                <b>{fmt.num(k.searches30)}</b>
                <span className="muted small">{t("kpi.searchesNote", { misses: fmt.num(k.misses30), pct: pctText(k.missPct, na) })}</span>
              </div>
              <div className="stat">
                <span className="muted small">{t("kpi.deflection")}</span>
                <b>{pctText(k.deflectionPct, na)}</b>
                <span className="muted small">{t("kpi.deflectionNote")}</span>
              </div>
              <div className={k.helpfulPct != null && k.helpfulPct < 70 ? "stat stat-warn" : "stat"}>
                <span className="muted small">{t("kpi.helpful")}</span>
                <b>{pctText(k.helpfulPct, na)}</b>
                <span className="muted small">{t("kpi.helpfulNote", { votes: fmt.num(k.votes30) })}</span>
              </div>
            </>
          )
        )}
      </section>

      <Tabs
        label={t("tabs.label")}
        value={tab}
        onChange={setTab}
        tabs={(["articles", "misses", "review"] as const).map((v) => ({
          value: v,
          label: (
            <>
              {t(`tabs.${v}`)} {overview.data && <span className="pill neu">{overview.data.tabs[v]}</span>}
            </>
          ),
        }))}
      />

      {tab === "misses" ? (
        <section className="card">
          {misses.isPending ? (
            <TableSkeleton rows={5} cols={5} />
          ) : misses.error ? (
            <ErrorBlock error={misses.error} retry={() => void misses.refetch()} />
          ) : !misses.data.items.length ? (
            <Empty ok title={t("missesEmpty")} description={t("missesEmptyDesc")} />
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col">{t("col.query")}</th>
                    <th scope="col">{t("col.searches")}</th>
                    <th scope="col">{t("col.ticketsAfter")}</th>
                    <th scope="col">{t("col.lastDay")}</th>
                    <th scope="col">{t("col.action")}</th>
                  </tr>
                </thead>
                <tbody>
                  {misses.data.items.map((m) => (
                    <tr key={m.query}>
                      <td className="cell-main">&quot;{m.query}&quot;</td>
                      <td className="num">{fmt.num(m.searches)}</td>
                      <td className="num">{fmt.num(m.tickets)}</td>
                      <td>{fmt.date(m.lastDay ?? null)}</td>
                      <td>{missRow(m)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">{t("missNote")}</p>
        </section>
      ) : (
        <div className={styles.layout}>
          <section className="card">
            {tab === "articles" && (
              <div className={styles.filters} role="group" aria-label={t("filter.label")}>
                {(["all", "published", "draft", "lowHelpful"] as const).map((f) => (
                  <Chip key={f} pressed={filter === f} onClick={() => setFilter(f)}>
                    {t(`filter.${f}`)}
                  </Chip>
                ))}
                <select className="input select-inline" aria-label={t("filter.category")} value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">{t("filter.allCategories")}</option>
                  {cats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <input className={`input ${styles.search}`} type="search" aria-label={t("filter.search")} placeholder={t("filter.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
            )}
            {list.isPending ? (
              <TableSkeleton rows={5} cols={8} />
            ) : list.error ? (
              <ErrorBlock error={list.error} retry={() => void list.refetch()} />
            ) : !list.data.items.length ? (
              tab === "review" ? (
                <Empty ok title={t("emptyReview")} description={t("emptyReviewDesc")} />
              ) : filter !== "all" || category || q ? (
                <Empty title={t("emptyFiltered")} onClearFilters={() => (setFilter("all"), setCategory(""), setSearch(""))} />
              ) : (
                <Empty title={t("empty")} description={t("emptyDesc")} />
              )
            ) : (
              <div className="tbl-wrap">
                <table className={`tbl ${styles.articleTable}`}>
                  <thead>
                    <tr>
                      <th scope="col" className={styles.colArticle}>{t("col.article")}</th>
                      <th scope="col" className={styles.colCategory}>{t("col.category")}</th>
                      <th scope="col">{t("col.status")}</th>
                      <th scope="col">{t("col.reads")}</th>
                      <th scope="col">{t("col.helpful")}</th>
                      <th scope="col">{t("col.tickets")}</th>
                      <th scope="col">{t("col.updated")}</th>
                      <th scope="col">{t("col.owner")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.items.map((a) => (
                      <tr key={a.id} onClick={() => router.push(`/help/${a.id}`)} style={{ cursor: "pointer" }}>
                        <td>
                          <Link className={styles.articleLink} href={`/help/${a.id}`} onClick={(e) => e.stopPropagation()}>
                            {a.title}
                          </Link>
                          <span className={styles.slug}>/help/{a.slug}</span>
                        </td>
                        <td>{a.category.name}</td>
                        <td>
                          {a.needsReview ? (
                            <span title={a.reviewReason ? t(`reason.${a.reviewReason}`) : undefined}>
                              <Pill tone="warn">{t("status.review")}</Pill>
                            </span>
                          ) : (
                            <Pill tone={a.status === "published" ? "ok" : "neu"}>{t(`status.${a.status}`)}</Pill>
                          )}
                          {a.hasDraft && a.status === "published" && <span className="cell-sub" style={{ display: "block" }}>{t("status.hasDraft")}</span>}
                        </td>
                        <td className="num">{a.status === "draft" ? "—" : fmt.num(a.reads30)}</td>
                        <td>{a.helpfulPct == null ? "—" : <Pill tone={helpfulTone(a.helpfulPct)}>{`${a.helpfulPct}%`}</Pill>}</td>
                        <td className="num">{fmt.num(a.tickets)}</td>
                        <td className="nowrap">{fmt.date(a.updatedAt)}</td>
                        <td>{a.owner?.name ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <aside className="card" aria-label={t("missesTitle")}>
            <div className="card-head">
              <h2 className="card-title">{t("missesTitle")}</h2>
              <span className="muted small push-end">{t("missesDays")}</span>
            </div>
            {overview.data && !overview.data.topMisses.length ? (
              <p className="muted small">{t("missesEmpty")}</p>
            ) : (
              <ul className={styles.missList}>
                {(overview.data?.topMisses ?? []).map((m) => (
                  <li key={m.query}>
                    <div>
                      <b>&quot;{m.query}&quot;</b>
                      <span className="muted small">{t("missMeta", { searches: m.searches, tickets: m.tickets })}</span>
                    </div>
                    {missRow(m)}
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      )}

      {modal === "categories" && categories.data && <CategoriesDialog categories={categories.data.items} onClose={() => setModal(null)} />}
      {modal === "create" && <CreateDialog categories={cats} onClose={() => setModal(null)} />}
      {fromTicket && canEdit && <FromTicketDialog ticketId={fromTicket} categories={cats} onClose={() => router.replace("/help")} />}
    </>
  );
}

/** "เขียนบทความ" · ถามหัวข้อกับหมวดแล้วสร้างร่าง (API ต้องมีทั้งสองช่อง) */
function CreateDialog({ categories, onClose }: { categories: Category[]; onClose: () => void }) {
  const t = useTranslations("help.create");
  const tl = useTranslations("help.list");
  const tc = useTranslations("common.dialog");
  const [title, setTitle] = useState("");
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const create = useCreateDraft();
  const ok = title.trim().length >= 3 && !!categoryId;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title")} description={t("desc")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && create.mutate({ title: title.trim(), categoryId }))}>
        <Input label={`${t("name")} *`} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        {categories.length ? (
          <Select label={`${t("category")} *`} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        ) : (
          <Notice tone="warn">{tl("noCategory")}</Notice>
        )}
        <InlineError error={create.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!ok || create.isPending}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
