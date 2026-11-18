"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { SlidersHorizontal, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { hasAny, initials, seesMoney } from "@/components/access";
import { ExportDialog } from "@/components/dialogs";
import { Chip, ChipGroup, Drawer, Empty, ErrorBlock, ListBar, Notice, PageHead, Pager, Switch, TableSkeleton, Tabs } from "@/components/kit";
import { Button, buttonClass, Input } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useRowNav } from "@/lib/shortcuts";
import { useUrlFilters } from "@/lib/url-state";
import { ActiveFilters, FilterButton, filterKeys, filterQuery } from "@/components/filters";
import { useWorkspaceFilters } from "./_parts/filters";
import { type AnnounceFilter, AnnounceDrawer } from "./_parts/Announce";
import { BulkCouponDialog, BulkResultDrawer, BulkTrialDialog, namesOf } from "./_parts/Bulk";
import styles from "./_parts/bulk.module.css";
import { healthTone, planLabel, useFmt } from "./_parts/format";
import { type TestFlag, TestLabelDialog } from "./_parts/TestLabel";
import type { BulkAction, BulkFilter, BulkResult, BulkTarget, Integration, Overview, WsList, WsRow } from "./_parts/types";

const SORTS = ["recent_activity", "mrr", "health", "newest", "overdue_risk", "trial_ending"] as const;
const FEATURES = ["line", "webhook", "github", "api_token", "automation", "import", "no_project"] as const;
/** แท็บสถานะ · ค่าเดียวกับตัวกรอง status ของ ops-api (trialing / past_due = สถานะแพ็กเกจ) */
const STATUSES = ["", "paying", "trialing", "past_due", "suspended"] as const;
/** ป้ายการเชื่อมต่อใช้ชื่อเดียวกับตัวกรองฟีเจอร์ (เคยแสดงคีย์ดิบ customers.integrations.import) */
const FEATURE_OF: Record<Integration, (typeof FEATURES)[number]> = { line: "line", webhook: "webhook", github: "github", apiToken: "api_token", automation: "automation", import: "import" };
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
  // ตัวกรองอยู่ใน URL: กดย้อนกลับจากหน้ารายละเอียดแล้วยังอยู่ที่เดิม · ส่งลิงก์ให้เพื่อนได้ (ช่วง 1)
  // ช่วง 3: ตัวกรองทั้งหมดของหน้า (แผงตัวกรองกลาง) · ค่าอยู่ใน URL · ใส่คีย์ MRR ไว้เสมอ เพราะสิทธิ์เห็นเงินรู้หลังโหลด me
  const defs = useWorkspaceFilters(money);
  const [f, setF] = useUrlFilters({ q: "", status: "", sort: "recent_activity", page: "0", buyer: "", test: "", suggest: "", ...filterKeys(defs), plan: "", feature: "", mrrMin: "", mrrMax: "" });
  const [q, setQ] = useState(f.q);
  const { plan, status, feature } = f;
  const fq = filterQuery(defs, f);
  const setFilters = (patch: Record<string, string>) => setF({ ...patch, page: "0" });
  const sort = ((SORTS as readonly string[]).includes(f.sort) ? f.sort : "recent_activity") as (typeof SORTS)[number];
  const offset = Number(f.page) * PAGE || 0;
  const setStatus = (v: string) => setF({ status: v, page: "0" });
  const setSort = (v: string) => setF({ sort: v });
  const setOffset = (v: number) => setF({ page: String(Math.floor(v / PAGE)) });
  const [peek, setPeek] = useState<string | null>(null);
  // เลือกข้ามหน้า (H4): เก็บเป็นรายการ id + ชื่อ ไม่ผูกกับหน้า · "filter" = เลือกทั้งหมดตามตัวกรอง (เซิร์ฟเวอร์หารายการตอนยืนยัน)
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [byFilter, setByFilter] = useState(false);
  const [bulk, setBulk] = useState<"trial" | "coupon" | "announce" | "test" | null>(null);
  const canLabel = hasAny(me, "owner", "support");
  const [done, setDone] = useState<{ action: BulkAction; result: BulkResult } | null>(null);
  const [exporting, setExporting] = useState(false);
  const search = useDeferredValue(q.trim());
  const filter = new URLSearchParams({
    limit: String(PAGE),
    offset: String(offset),
    sort,
    ...(search ? { q: search } : {}),
    ...fq,
    ...(status ? { status } : {}),
    ...(f.buyer ? { buyer: f.buyer } : {}),
    // ตรวจรายการที่ระบบเสนอ: ดูเฉพาะที่ยังไม่ติดป้าย (ค่าเริ่มต้นของ ops-api ซ่อน Workspace ทดสอบ)
    ...(f.test ? { test: f.test } : {}),
    ...(f.suggest ? { suggest: f.suggest } : {}),
  });
  const list = useQuery({ queryKey: ["ops", "workspaces", filter.toString()], queryFn: () => api.get<WsList>(`/workspaces?${filter}`), placeholderData: keepPreviousData });
  useEffect(() => {
    // เขียนคำค้นลง URL เมื่อพิมพ์นิ่งแล้ว
    if (search !== f.q) setF({ q: search, page: "0" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  // เปลี่ยนตัวกรองแล้วล้างการเลือก (รายการที่เลือกไว้อาจไม่อยู่ในตัวกรองใหม่) · เปลี่ยนการเรียงไม่ล้าง
  const filterKey = `${search}|${JSON.stringify(fq)}|${status}|${f.buyer}|${f.test}|${f.suggest}`;
  const lastFilter = useRef(filterKey);
  useEffect(() => {
    if (lastFilter.current === filterKey) return;
    lastFilter.current = filterKey;
    setSelected(new Map());
    setByFilter(false);
  }, [filterKey]);
  const rows = list.data?.items ?? [];
  const tk = useTranslations("common.keys");
  const nav = useRowNav(rows, { onOpen: (r) => setPeek(r.id), onToggle: (r) => toggle(r.id, r.name, !selected.has(r.id)), labels: { down: tk("down"), open: tk("open"), toggle: tk("toggle") } });
  const total = list.data?.total ?? 0;
  const filtered = !!(search || Object.keys(fq).length || status || f.buyer || f.suggest);
  const clear = () => (setQ(""), setF({ ...filterKeys(defs), q: "", status: "", page: "0", buyer: "", suggest: "" }));
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
  const serverFilter: BulkFilter = {
    ...fq,
    ...(status ? { status } : {}),
    ...(search ? { q: search } : {}),
    ...(f.buyer ? { buyer: f.buyer } : {}),
    ...(f.test ? { test: f.test as BulkFilter["test"] } : {}),
    ...(f.suggest ? { suggest: f.suggest as BulkFilter["suggest"] } : {}),
  };
  const target: BulkTarget = byFilter ? { filter: serverFilter } : { ids: [...selected.keys()] };
  const count = byFilter ? total : selected.size;
  const filterText = [plan && plan.split(",").map(planLabel).join(", "), status && (status === "paying" ? t("list.tabs.paying") : t.has(`wsStatus.${status}` as "wsStatus.trial") ? t(`wsStatus.${status}` as "wsStatus.trial") : t.has(`subStatus.${status}` as "subStatus.trialing") ? t(`subStatus.${status}` as "subStatus.trialing") : status), feature && t(`list.features.${feature}` as "list.features.line"), search && `"${search}"`].filter(Boolean).join(" · ");
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
        desc={list.data ? (f.test !== "all" && list.data.tests?.hidden ? t("list.summaryHidden", { total, hidden: list.data.tests.hidden }) : t("list.summary", { total })) : undefined}
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
      {/* ช่วง 1: ระบบเสนอ Workspace ที่น่าจะเป็นทดสอบ · ตรวจและติดป้ายบนตารางนี้ (ค้นหา แบ่งหน้า เลือกตามตัวกรองได้) */}
      {canLabel && !f.suggest && !!list.data?.tests?.suggested && (
        <Notice
          tone="info"
          title={t("test.suggestTitle", { n: list.data.tests.suggested })}
          action={
            <Button size="small" onClick={() => setF({ suggest: "any", test: "", buyer: "", page: "0" })}>
              {t("test.review")}
            </Button>
          }
        >
          {t("test.suggestWhy")}
        </Notice>
      )}
      {/* โครงหน้า Ops: แท็บสถานะ · ค้นหา · ตัวกรองอื่นอยู่ในปุ่ม "ตัวกรอง" (แพ็กเกจ / ฟีเจอร์เคยกินสองแถว) */}
      <ListBar
        tabs={
          <Tabs
            label={t("list.status")}
            value={(STATUSES as readonly string[]).includes(status) ? (status as (typeof STATUSES)[number]) : ""}
            onChange={setStatus}
            tabs={STATUSES.map((v) => ({
              value: v,
              label: (
                <>
                  {v ? t(`list.tabs.${v}`) : t("list.all")}
                  {list.data?.counts && <span className="tab-count">{fmt.num(list.data.counts[v || "all"])}</span>}
                </>
              ),
            }))}
          />
        }
      >
        <Input data-page-search aria-label={t("list.search")} placeholder={t("list.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        <FilterButton defs={defs} values={f} onChange={setFilters} />
        <label className="row small muted" style={{ gap: 6 }}>
          <Switch checked={f.test === "all"} onChange={(on) => setF({ test: on ? "all" : "", page: "0" })} label={t("test.showTests")} />
          {t("test.showTests")}
        </label>
        <select className="input" style={{ width: "auto" }} aria-label={t("list.sort")} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          {SORTS.filter((s) => s !== "mrr" || money).map((s) => (
            <option key={s} value={s}>
              {t(`list.sorts.${s}`)}
            </option>
          ))}
        </select>
      </ListBar>
      <ActiveFilters defs={defs} values={f} onChange={setFilters} />
      {(f.buyer || f.suggest) && (
        <div className="row">
          {f.suggest && (
            <>
              <span className="filter-chip">
                {t("test.suggestChip", { n: total })}
                <button type="button" className="link-button" aria-label={t("test.clearSuggest")} onClick={() => setF({ suggest: "", page: "0" })}>
                  <X size={12} />
                </button>
              </span>
              <ChipGroup className="row" role="group" aria-label={t("test.reasonLabel")}>
                {(["any", "staff_domain", "name_prefix"] as const).map((r) => (
                  <Chip key={r} pressed={f.suggest === r} onClick={() => setF({ suggest: r, page: "0" })}>
                    {t(`test.reasons.${r}`)}
                  </Chip>
                ))}
              </ChipGroup>
            </>
          )}
          {f.buyer && (
            <span className="filter-chip">
              {t("buyer.chip", { name: list.data?.buyer?.name ?? t("buyer.unknown") })}
              <button type="button" className="link-button" aria-label={t("buyer.clear")} onClick={() => setF({ buyer: "", page: "0" })}>
                <X size={12} />
              </button>
            </span>
          )}
        </div>
      )}
      {list.data?.buyer && (
        <div className="sum-row" role="status">
          <span>
            {t("buyer.sumWorkspaces")} <b>{list.data.buyer.workspaces}</b>
          </span>
          <span>
            {t("buyer.sumSeats")} <b>{`${list.data.buyer.seats} / ${list.data.buyer.seatLimit || "∞"}`}</b>
          </span>
          {money && list.data.buyer.mrr != null && (
            <span>
              {t("buyer.sumMrr")} <b>{fmt.money(list.data.buyer.mrr)}</b>
            </span>
          )}
          <span>
            {t("buyer.sumTickets")} <b>{list.data.buyer.openTickets}</b>
          </span>
        </div>
      )}
      <div className="stack">
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
              {canLabel && (
                <Button size="small" onClick={() => setBulk("test")}>
                  {t("test.labelAction")}
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
                    <th>{t("buyer.col")}</th>
                    <th>{t("list.col.status")}</th>
                    <th className="num">{t("list.col.seats")}</th>
                    {f.suggest ? <th>{t("test.reasonCol")}</th> : <th className="num">{t("list.col.health")}</th>}
                    {money && <th className="num">{t("list.col.mrr")}</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.id} className="row-link" aria-selected={peek === r.id} onClick={() => setPeek(r.id)} {...nav.rowProps(i)}>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" aria-label={`${t("list.col.select")} ${r.name}`} checked={byFilter || selected.has(r.id)} disabled={byFilter} onChange={(e) => toggle(r.id, r.name, e.target.checked)} />
                      </td>
                      <td>
                        {/* ชื่อกับ slug บรรทัดเดียว · กดชื่อเปิดสรุปในแผงขวา */}
                        <button type="button" className="row-link-button row nowrap" onClick={(e) => (e.stopPropagation(), setPeek(r.id))}>
                          <span className="avatar avatar-sm" aria-hidden="true">
                            {initials(r.name)}
                          </span>
                          <span className="cell-main">{r.name}</span>
                          <span className="cell-sub">
                            {r.slug} · {planLabel(r.plan)}
                          </span>
                          {r.test?.isTest && <span className="pill">{t("test.pill")}</span>}
                        </button>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {/* ผู้ซื้อ: ชื่อบริษัทจากข้อมูลภาษี หรืออีเมลเจ้าของ · มีหลาย Workspace กดเพื่อกรองเฉพาะผู้ซื้อรายนี้ */}
                        <span className="stack-tight">
                          <span className={r.buyer?.company ? undefined : "muted small"}>{r.buyer?.name ?? "—"}</span>
                          {!!r.buyer?.key && r.buyer.count > 1 && !f.buyer && (
                            <button type="button" className="count-chip" onClick={() => setF({ buyer: r.buyer.key!, page: "0", suggest: "" })}>
                              {t("buyer.more", { n: r.buyer.count - 1 })}
                            </button>
                          )}
                        </span>
                      </td>
                      <td>
                        <span className={r.status === "suspended" ? "pill bad" : r.paymentState === "overdue" || r.subStatus === "past_due" ? "pill warn" : r.subStatus === "active" ? "pill ok" : "pill"}>
                          {r.status === "suspended" ? (r.suspensionMode ? t(`list.suspendedMode.${r.suspensionMode}`) : t("wsStatus.suspended")) : t(`subStatus.${r.subStatus ?? "none"}`)}
                        </span>
                      </td>
                      <td className="num">{r.seatLimit ? `${r.seats} / ${r.seatLimit}` : r.seats}</td>
                      {f.suggest ? (
                        <td>{r.test?.suggest && <span className="pill">{t(`test.reasons.${r.test.suggest}`)}</span>}</td>
                      ) : (
                        <td className="num">
                          <span className={`pill ${healthTone(r.health)}`}>{r.health}</span>
                        </td>
                      )}
                      {money && <td className="num">{fmt.money(r.mrr)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager hotkeys offset={offset} limit={PAGE} shown={rows.length} total={total} onChange={setOffset} />
          </>
        )}
      </div>
      <WsPeek id={peek} row={rows.find((r) => r.id === peek) ?? null} onClose={() => setPeek(null)} onBuyer={(key) => (setPeek(null), setF({ buyer: key, page: "0", suggest: "" }))} />
      {bulk === "announce" && (
        <AnnounceDrawer
          workspaceIds={[...selected.keys()]}
          // ตัวกรองปัจจุบันของรายการ ให้เลือกส่ง "ทุกรายตามตัวกรอง" ได้ (O43 · S8)
          filter={filtered ? ({ ...(plan && !plan.includes(",") ? { plan } : {}), ...(status ? { status } : {}), ...(search ? { q: search } : {}), ...(feature ? { feature } : {}) } as AnnounceFilter) : undefined}
          sampleName={[...selected.values()][0]}
          onClose={() => setBulk(null)}
          onDone={() => (setBulk(null), resetSelection())}
        />
      )}
      {bulk === "test" && <TestLabelDialog target={target} count={count} names={[...selected.values()]} onClose={() => setBulk(null)} onDone={() => (setBulk(null), resetSelection(), void list.refetch())} />}
      {bulk === "trial" && <BulkTrialDialog target={target} count={count} subtitle={t(byFilter ? "bulk.trialSub" : "bulk.trialSubPicked", byFilter ? { scope } : { names: scope })} onOpenChange={() => setBulk(null)} onDone={(r) => finish("extend_trial", r)} />}
      {bulk === "coupon" && <BulkCouponDialog target={target} count={count} subtitle={t("bulk.couponSub", { names: scope })} onOpenChange={() => setBulk(null)} onDone={(r, action) => finish(action, r)} />}
      {done && <BulkResultDrawer action={done.action} result={done.result} onOpenChange={() => setDone(null)} />}
      <ExportDialog
        open={exporting}
        onOpenChange={setExporting}
        title={t("list.export")}
        filename="friday-workspaces.csv"
        rows={rows.map((r) => ({ ...r, plan: planLabel(r.plan), integrations: r.integrations.map((i) => t(`list.features.${FEATURE_OF[i]}`)).join(" ") }))}
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

/** สรุปลูกค้าในแผงขวา (โครงหน้า Ops) · งานละเอียด (โปรเจกต์ ผู้ใช้ Audit log ปุ่มเงิน) อยู่หน้าเต็ม */
function WsPeek({ id, row, onClose, onBuyer }: { id: string | null; row: WsRow | null; onClose: () => void; onBuyer: (key: string) => void }) {
  const t = useTranslations("customers");
  const fmt = useFmt();
  const me = useMe().data;
  const q = useQuery({ queryKey: ["ops", "workspace", id], queryFn: () => api.get<Overview>(`/workspaces/${id}`), enabled: !!id });
  const o = q.data;
  const sub = o?.subscription;
  const owner = o?.owners.find((x) => x.role === "owner");
  const tt = useTranslations("customers.test");
  const [labeling, setLabeling] = useState<TestFlag | null>(null);
  const test = o?.test;
  return (
    <Drawer open={!!id} onOpenChange={(v) => !v && onClose()} title={o?.name ?? row?.name ?? t("list.title")} description={row ? <span className="mono">{row.slug}</span> : undefined}>
      {q.isPending ? (
        <TableSkeleton rows={6} cols={2} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        o && (
          <>
            <div className="row">
              <span className="pill">{planLabel(sub?.plan ?? null)}</span>
              <span className={o.status === "suspended" ? "pill bad" : sub?.status === "past_due" ? "pill warn" : sub?.status === "active" ? "pill ok" : "pill"}>
                {o.status === "suspended" ? t("wsStatus.suspended") : t(`subStatus.${(sub?.status ?? "none") as "none"}`)}
              </span>
              <span className={`pill ${healthTone(o.health.score)}`}>{t("peek.health", { n: o.health.score })}</span>
              {test?.isTest && <span className="pill">{tt("pill")}</span>}
            </div>
            {test?.isTest && (
              <p className="muted small">
                {test.flag === "test" ? tt("labeledBy", { by: test.by ?? "—", reason: test.reason ?? "" }) : tt("autoNote")}
              </p>
            )}
            {!o.supportAccess?.active && <Notice tone="warn">{t("peek.noAccess")}</Notice>}
            <table className="tbl">
              <tbody>
                <tr>
                  <td className="muted">{t("buyer.col")}</td>
                  <td className="cell-wrap">{o.buyer?.name ?? "—"}</td>
                </tr>
                <tr>
                  <td className="muted">{t("peek.owner")}</td>
                  <td className="cell-wrap">{owner ? (owner.email ?? owner.displayName) : "—"}</td>
                </tr>
                <tr>
                  <td className="muted">{t("list.col.seats")}</td>
                  <td>{sub?.seatLimit ? `${o.usage.members} / ${sub.seatLimit}` : o.usage.members}</td>
                </tr>
                <tr>
                  <td className="muted">{sub?.status === "trialing" ? t("peek.trialEnds") : t("peek.next")}</td>
                  <td>{sub?.status === "trialing" ? (sub.trialEndsAt ? fmt.date(sub.trialEndsAt) : "—") : sub?.currentPeriodEnd ? fmt.date(sub.currentPeriodEnd) : "—"}</td>
                </tr>
                <tr>
                  <td className="muted">{t("list.col.active")}</td>
                  <td>{t("peek.active", { n: o.usage.active30, last: o.usage.lastActiveAt ? fmt.ago(o.usage.lastActiveAt) : "—" })}</td>
                </tr>
                <tr>
                  <td className="muted">{t("peek.usage")}</td>
                  <td>{t("peek.usageValue", { projects: o.usage.projects, storage: fmt.bytes(o.usage.storageBytes) })}</td>
                </tr>
                <tr>
                  <td className="muted">{t("list.col.integrations")}</td>
                  <td className="cell-wrap">{o.integrations.length ? o.integrations.map((i) => t(`list.features.${FEATURE_OF[i]}`)).join(" · ") : t("integrations.none")}</td>
                </tr>
              </tbody>
            </table>
            {!!o.buyer?.others.length && (
              <section className="stack" aria-label={t("buyer.others")}>
                <b className="small">{t("buyer.others")}</b>
                {o.buyer.others.map((w) => (
                  <Link key={w.id} href={`/workspaces/${w.id}`} className="row small">
                    <b>{w.name}</b>
                    <span className="muted">{w.slug} · {planLabel(w.plan)}</span>
                  </Link>
                ))}
                {o.buyer.count - 1 > o.buyer.others.length && o.buyer.key && (
                  <button type="button" className="link-button small" onClick={() => onBuyer(o.buyer!.key!)}>
                    {t("buyer.seeAll", { n: o.buyer.count })}
                  </button>
                )}
              </section>
            )}
            {hasAny(me, "owner", "support") && (
              <div className="row small">
                {test?.isTest ? (
                  <Button size="small" variant="ghost" onClick={() => setLabeling(test.flag === "test" ? "clear" : "not_test")}>
                    {test.flag === "test" ? tt("actions.clear") : tt("actions.not_test")}
                  </Button>
                ) : (
                  <Button size="small" variant="ghost" onClick={() => setLabeling("test")}>
                    {tt("actions.test")}
                  </Button>
                )}
              </div>
            )}
            {labeling && <TestLabelDialog target={{ ids: [o.id] }} count={1} names={[o.name]} flag={labeling} onClose={() => setLabeling(null)} onDone={() => setLabeling(null)} />}
            <div className="row">
              {hasAny(me, "owner", "support") && (
                <Link className={buttonClass()} href={`/support?workspace=${o.id}`}>
                  {t("peek.tickets")}
                </Link>
              )}
              <span className="spacer" />
              <Link className={buttonClass("primary")} href={`/workspaces/${o.id}`}>
                {t("peek.open")}
              </Link>
            </div>
          </>
        )
      )}
    </Drawer>
  );
}
