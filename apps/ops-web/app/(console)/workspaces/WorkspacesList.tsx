"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDeferredValue, useEffect, useState } from "react";
import { hasAny, initials, seesMoney } from "@/components/access";
import { ExportDialog, useApprovalFlow } from "@/components/dialogs";
import { Chip, Empty, ErrorBlock, PageHead, TableSkeleton } from "@/components/kit";
import { Button, buttonClass, Input, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/query";
import { DiscountDialog, TrialDialog } from "./_parts/Actions";
import { healthTone, planLabel, useFmt } from "./_parts/format";
import type { WsList, WsRow } from "./_parts/types";

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
  const toast = useToast();
  const { handle } = useApprovalFlow();
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
  const [selected, setSelected] = useState<string[]>([]);
  const [bulk, setBulk] = useState<"trial" | "coupon" | null>(null);
  const [exporting, setExporting] = useState(false);
  const search = useDeferredValue(q.trim());
  const filter = new URLSearchParams({ limit: String(PAGE), offset: String(offset), sort, ...(search ? { q: search } : {}), ...(plan ? { plan } : {}), ...(status ? { status } : {}), ...(feature ? { feature } : {}) });
  const list = useQuery({ queryKey: ["ops", "workspaces", filter.toString()], queryFn: () => api.get<WsList>(`/workspaces?${filter}`), placeholderData: keepPreviousData });
  useEffect(() => setOffset(0), [search, plan, sort, feature]);
  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const filtered = !!(search || plan || feature || status);
  const clear = () => (setQ(""), setPlan(""), setFeature(""));
  const picked = rows.filter((r) => selected.includes(r.id));

  /** ทำรายการหลายราย: เรียกทีละราย · เกินวงเงินขึ้นคำขออนุมัติรายตัว */
  const runBulk = async (fn: (row: WsRow) => Promise<unknown>) => {
    let ok = 0;
    let pending = 0;
    let failed = 0;
    for (const r of picked) {
      try {
        const res = (await fn(r)) as { pendingApproval?: unknown };
        if (res?.pendingApproval) pending++;
        else ok++;
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        failed++;
      }
    }
    toast({ message: t("list.bulkDone", { ok, pending, failed }), tone: failed ? "error" : "ok" });
    setSelected([]);
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
          <div className="row" role="group" aria-label={t("list.plan")}>
            {PLANS.map((p) => (
              <Chip key={p || "all"} pressed={plan === p} onClick={() => setPlan(p)}>
                {p ? planLabel(p) : t("list.all")}
              </Chip>
            ))}
          </div>
          <select className="input" style={{ width: "auto" }} aria-label={t("list.sort")} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            {SORTS.filter((s) => s !== "mrr" || money).map((s) => (
              <option key={s} value={s}>
                {t(`list.sorts.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="row" role="group" aria-label={t("list.feature")}>
          <span className="muted small">{t("list.feature")}</span>
          {FEATURES.map((f) => (
            <Chip key={f} pressed={feature === f} onClick={() => setFeature(feature === f ? "" : f)}>
              {t(`list.features.${f}`)}
            </Chip>
          ))}
        </div>
        {selected.length > 0 && (
          <div className="notice notice-info" role="status">
            <b>{t("list.selected", { count: selected.length })}</b>
            <span className="muted small">{t("list.bulkNote")}</span>
            <span className="spacer" />
            {hasAny(me, "support") && <Button onClick={() => setBulk("trial")}>{t("list.bulkTrial")}</Button>}
            {hasAny(me, "finance") && <Button onClick={() => setBulk("coupon")}>{t("list.bulkCoupon")}</Button>}
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
                      <span className="sr-only">{t("list.col.select")}</span>
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
                        <input type="checkbox" aria-label={`${t("list.col.select")} ${r.name}`} checked={selected.includes(r.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, r.id] : selected.filter((x) => x !== r.id))} />
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
                          {r.status === "suspended" ? t("wsStatus.suspended") : t(`subStatus.${r.subStatus ?? "none"}`)}
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
      {bulk === "trial" && (
        <TrialDialog
          names={picked.map((p) => p.name)}
          onOpenChange={() => setBulk(null)}
          submit={(body) => runBulk((r) => api.post(`/workspaces/${r.id}/extend-trial`, body))}
        />
      )}
      {bulk === "coupon" && (
        <DiscountDialog
          names={picked.map((p) => p.name)}
          onOpenChange={() => setBulk(null)}
          submit={(body) => runBulk((r) => api.post(`/workspaces/${r.id}/discount`, body).then(handle))}
        />
      )}
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
