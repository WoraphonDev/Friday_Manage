"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { hasAny, initials, seesMoney } from "@/components/access";
import { ExportDialog } from "@/components/dialogs";
import { Chip, ChipGroup, Empty, ErrorBlock, PageHead, TableSkeleton } from "@/components/kit";
import { Button, buttonClass, Input } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { type AnnounceFilter, AnnounceDrawer } from "./_parts/Announce";
import { BulkCouponDialog, BulkResultDrawer, BulkTrialDialog, namesOf } from "./_parts/Bulk";
import styles from "./_parts/bulk.module.css";
import { healthTone, planLabel, useFmt } from "./_parts/format";
import type { BulkAction, BulkFilter, BulkResult, BulkTarget, WsList } from "./_parts/types";

const PLANS = ["", "free", "team_s", "team_m", "team_l", "enterprise"] as const;
const SORTS = ["recent_activity", "mrr", "health", "newest"] as const;
const FEATURES = ["line", "webhook", "github", "api_token", "automation", "import", "no_project"] as const;
const PAGE = 50;

/** หน้า 2 · Workspaces (Customers.dc.html) */
export function WorkspacesList() {
  const t = useTranslations("customers");
  const params = useSearchParams();
  const router = useRouter();
  const fmt = useFmt();
  const me = useMe().data;
  const money = seesMoney(me);
  const tbulk = useTranslations("customers.bulk");
  // ลิงก์เดิมจากค้นหาทั้งระบบ (`?id=`) → หน้ารายละเอียด
  useEffect(() => {
    const id = params?.get("id");
    if (id) router.replace(`/workspaces/${id}`);
  }, [params, router]);
  const [q, setQ] = useState("");
  const [plan, setPlan] = useState(params?.get("plan") ?? "");
  const [status] = useState(params?.get("status") ?? "");
  const [sort, setSort] = useState<(typeof SORTS)[number]>(money ? "recent_activity" : "recent_activity");
  const [feature, setFeature] = useState("");
  const [offset, setOffset] = useState(0);
  // เลือกข้ามหน้า (H4): เก็บเป็นรายการ id + ชื่อ ไม่ผูกกับหน้า · "filter" = เลือกทั้งหมดตามตัวกรอง (เซิร์ฟเวอร์หารายการตอนยืนยัน)
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [byFilter, setByFilter] = useState(false);
  const [bulk, setBulk] = useState<"trial" | "coupon" | "announce" | null>(null);
  const [done, setDone] = useState<{ action: BulkAction; result: BulkResult } | null>(null);
  const [exporting, setExporting] = useState(false);
  const search = useDeferredValue(q.trim());
  const filter = new URLSearchParams({ limit: String(PAGE), offset: String(offset), sort, ...(search ? { q: search } : {}), ...(plan ? { plan } : {}), ...(status ? { status } : {}), ...(feature ? { feature } : {}) });
  const list = useQuery({ queryKey: ["ops", "workspaces", filter.toString()], queryFn: () => api.get<WsList>(`/workspaces?${filter}`), placeholderData: keepPreviousData });
  useEffect(() => setOffset(0), [search, plan, sort, feature]);
  // เปลี่ยนตัวกรองแล้วล้างการเลือก (รายการที่เลือกไว้อาจไม่อยู่ในตัวกรองใหม่) · เปลี่ยนการเรียงไม่ล้าง
  const filterKey = `${search}|${plan}|${status}|${feature}`;
  const lastFilter = useRef(filterKey);
  useEffect(() => {
    if (lastFilter.current === filterKey) return;
    lastFilter.current = filterKey;
    setSelected(new Map());
    setByFilter(false);
  }, [filterKey]);
  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const filtered = !!(search || plan || feature || status);
  const clear = () => (setQ(""), setPlan(""), setFeature(""));
  const pageAll = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const pageSome = rows.some((r) => selected.has(r.id));
  const headBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headBox.current) headBox.current.indeterminate = pageSome && !pageAll;
  }, [pageSome, pageAll]);
  const toggle = (id: string, name: string, on: boolean) => {
    const next = new Map(selected);
    if (on) next.set(id, name);
    else next.delete(id);
    setSelected(next);
    setByFilter(false);
  };
  const togglePage = (on: boolean) => {
    const next = new Map(selected);
    for (const r of rows) {
      if (on) next.set(r.id, r.name);
      else next.delete(r.id);
    }
    setSelected(next);
    setByFilter(false);
  };
  const resetSelection = () => (setSelected(new Map()), setByFilter(false));
  const serverFilter: BulkFilter = { ...(plan ? { plan } : {}), ...(status ? { status } : {}), ...(search ? { q: search } : {}), ...(feature ? { feature } : {}) };
  const target: BulkTarget = byFilter ? { filter: serverFilter } : { ids: [...selected.keys()] };
  const count = byFilter ? total : selected.size;
  const filterText = [plan && planLabel(plan), status && (t.has(`wsStatus.${status}` as "wsStatus.trial") ? t(`wsStatus.${status}` as "wsStatus.trial") : t.has(`subStatus.${status}` as "subStatus.trialing") ? t(`subStatus.${status}` as "subStatus.trialing") : status), feature && t(`list.features.${feature}` as "list.features.line"), search && `"${search}"`].filter(Boolean).join(" · ");
  const tb = (key: "byFilter" | "byFilterAll") => (key === "byFilter" ? t("bulk.byFilter", { filter: filterText }) : t("bulk.byFilterAll"));
  const scope = byFilter ? tb(filterText ? "byFilter" : "byFilterAll") : namesOf(tbulk, [...selected.values()], selected.size);
  const finish = (action: BulkAction, result: BulkResult) => {
    setBulk(null);
    setDone({ action, result });
    resetSelection();
    void list.refetch();
  };

  return (
    <>
      <PageHead
        title={t("list.title")}
        desc={list.data ? t("list.summary", { total }) : undefined}
        actions={
          <>
            {hasAny(me, "owner", "support") && (
              <Link className={buttonClass()} href="/users">
                {t("list.users")}
              </Link>
            )}
            <Button disabled={!rows.length} onClick={() => setExporting(true)}>
              {t("list.export")}
            </Button>
          </>
        }
      />
      <section className="card">
        <div className="row">
          <div style={{ flex: "1 1 260px" }}>
            <Input aria-label={t("list.search")} placeholder={t("list.search")} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <ChipGroup className="row" role="group" aria-label={t("list.plan")}>
            {PLANS.map((p) => (
              <Chip key={p || "all"} pressed={plan === p} onClick={() => setPlan(p)}>
                {p ? planLabel(p) : t("list.all")}
              </Chip>
            ))}
          </ChipGroup>
          <select className="input" style={{ width: "auto" }} aria-label={t("list.sort")} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            {SORTS.filter((s) => s !== "mrr" || money).map((s) => (
              <option key={s} value={s}>
                {t(`list.sorts.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <ChipGroup className="row" role="group" aria-label={t("list.feature")}>
          <span className="muted small">{t("list.feature")}</span>
          {FEATURES.map((f) => (
            <Chip key={f} pressed={feature === f} onClick={() => setFeature(feature === f ? "" : f)}>
              {t(`list.features.${f}`)}
            </Chip>
          ))}
        </ChipGroup>
        {/* แถบทำรายการหลายแถว (H4) ขึ้นเมื่อเริ่มติ๊กเลือก: เลื่อนเข้าแบบนุ่ม */}
        {(selected.size > 0 || byFilter) && (
          <div className={`${styles.bar} motion-in`} role="status">
            <b>{byFilter ? t("list.selectedByFilter", { total }) : pageAll && selected.size === rows.length ? t("list.selectedPage", { count: selected.size }) : t("list.selectedAll", { count: selected.size })}</b>
            {byFilter ? (
              <button type="button" className={styles.link} onClick={() => setByFilter(false)}>
                {t("list.selectOnlyPage")}
              </button>
            ) : (
              total > selected.size && (
                <button type="button" className={styles.link} onClick={() => setByFilter(true)}>
                  {t("list.selectByFilter", { total })}
                </button>
              )
            )}
            <span className={styles.hint}>{t("list.bulkNote")}</span>
            <span className={styles.actions}>
              {/* ประกาศถึงลูกค้า: เฉพาะ Owner ของทีม (ops-api ตรวจซ้ำ) · ตามตัวกรองยังไม่รองรับ (รอ O43) จึงปิดไว้พร้อมเหตุผล */}
              {hasAny(me, "owner") && (
                <Button size="small" disabled={byFilter} title={byFilter ? t("list.announceFilterHint") : undefined} onClick={() => setBulk("announce")}>
                  {t("list.bulkAnnounce")}
                </Button>
              )}
              {hasAny(me, "support") && (
                <Button size="small" onClick={() => setBulk("trial")}>
                  {t("list.bulkTrial")}
                </Button>
              )}
              {hasAny(me, "finance") && (
                <Button size="small" onClick={() => setBulk("coupon")}>
                  {t("list.bulkCoupon")}
                </Button>
              )}
              <Button size="small" variant="ghost" onClick={resetSelection}>
                {t("list.clear")}
              </Button>
            </span>
          </div>
        )}
        {list.isPending ? (
          <TableSkeleton rows={6} cols={8} />
        ) : list.error ? (
          <ErrorBlock error={list.error} retry={() => void list.refetch()} />
        ) : !rows.length ? (
          <Empty title={filtered ? t("list.emptyFiltered") : t("list.empty")} onClearFilters={filtered ? clear : undefined} />
        ) : (
          <>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>
                      <input ref={headBox} type="checkbox" aria-label={t("list.selectPage")} checked={pageAll || (byFilter && rows.length > 0)} disabled={byFilter} onChange={(e) => togglePage(e.target.checked)} />
                    </th>
                    <th>{t("list.col.ws")}</th>
                    <th>{t("list.col.status")}</th>
                    <th className="num">{t("list.col.seats")}</th>
                    <th className="num">{t("list.col.projects")}</th>
                    <th className="num">{t("list.col.active")}</th>
                    <th className="num">{t("list.col.storage")}</th>
                    <th>{t("list.col.integrations")}</th>
                    <th>{t("list.col.health")}</th>
                    {money && <th className="num">{t("list.col.mrr")}</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <input type="checkbox" aria-label={`${t("list.col.select")} ${r.name}`} checked={byFilter || selected.has(r.id)} disabled={byFilter} onChange={(e) => toggle(r.id, r.name, e.target.checked)} />
                      </td>
                      <td>
                        <Link href={`/workspaces/${r.id}`} className="row" style={{ flexWrap: "nowrap", textDecoration: "none", color: "inherit" }}>
                          <span className="avatar avatar-sm" aria-hidden="true">
                            {initials(r.name)}
                          </span>
                          <span>
                            <span className="cell-main">{r.name}</span>
                            <span className="cell-sub" style={{ display: "block" }}>
                              {planLabel(r.plan)} · {r.slug}
                            </span>
                          </span>
                        </Link>
                      </td>
                      <td>
                        <span className={r.status === "suspended" ? "pill bad" : r.paymentState === "overdue" || r.subStatus === "past_due" ? "pill warn" : r.subStatus === "active" ? "pill ok" : "pill"}>
                          {r.status === "suspended" ? (r.suspensionMode ? t(`list.suspendedMode.${r.suspensionMode}`) : t("wsStatus.suspended")) : t(`subStatus.${r.subStatus ?? "none"}`)}
                        </span>
                      </td>
                      <td className="num">{r.seatLimit ? `${r.seats} / ${r.seatLimit}` : r.seats}</td>
                      <td className="num">{r.projects}</td>
                      <td className="num">{r.active30}</td>
                      <td className="num">{fmt.bytes(r.storageBytes)}</td>
                      <td>
                        <span className="row">
                          {r.integrations.map((i) => (
                            <span key={i} className="pill">
                              {t(`integrations.${i}`)}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td>
                        <span className={`pill ${healthTone(r.health)}`}>{r.health}</span>
                      </td>
                      {money && <td className="num">{fmt.money(r.mrr)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row">
              <span className="muted small">{t("list.range", { from: offset + 1, to: offset + rows.length, total })}</span>
              <span className="spacer" />
              <Button size="small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                {t("list.prev")}
              </Button>
              <Button size="small" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
                {t("list.next")}
              </Button>
            </div>
          </>
        )}
      </section>
      {bulk === "announce" && (
        <AnnounceDrawer
          workspaceIds={[...selected.keys()]}
          // ตัวกรองปัจจุบันของรายการ ให้เลือกส่ง "ทุกรายตามตัวกรอง" ได้ (O43 · S8)
          filter={filtered ? ({ ...(plan ? { plan } : {}), ...(status ? { status } : {}), ...(search ? { q: search } : {}), ...(feature ? { feature } : {}) } as AnnounceFilter) : undefined}
          sampleName={[...selected.values()][0]}
          onClose={() => setBulk(null)}
          onDone={() => (setBulk(null), resetSelection())}
        />
      )}
      {bulk === "trial" && <BulkTrialDialog target={target} count={count} subtitle={t(byFilter ? "bulk.trialSub" : "bulk.trialSubPicked", byFilter ? { scope } : { names: scope })} onOpenChange={() => setBulk(null)} onDone={(r) => finish("extend_trial", r)} />}
      {bulk === "coupon" && <BulkCouponDialog target={target} count={count} subtitle={t("bulk.couponSub", { names: scope })} onOpenChange={() => setBulk(null)} onDone={(r, action) => finish(action, r)} />}
      {done && <BulkResultDrawer action={done.action} result={done.result} onOpenChange={() => setDone(null)} />}
      <ExportDialog
        open={exporting}
        onOpenChange={setExporting}
        title={t("list.export")}
        filename="friday-workspaces.csv"
        rows={rows.map((r) => ({ ...r, plan: planLabel(r.plan), integrations: r.integrations.join(" ") }))}
        columns={[
          { key: "name", label: t("list.col.ws") },
          { key: "slug", label: "slug" },
          { key: "plan", label: t("list.plan") },
          { key: "subStatus", label: t("list.col.status") },
          { key: "seats", label: t("list.col.seats") },
          { key: "active30", label: t("list.col.active") },
          { key: "health", label: t("list.col.health") },
          { key: "integrations", label: t("list.col.integrations") },
          ...(money ? [{ key: "mrr", label: `${t("list.col.mrr")} (สตางค์)` }] : []),
        ]}
      />
    </>
  );
}
