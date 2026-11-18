"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { hasAny, initials, seesMoney } from "@/components/access";
import { ExportDialog } from "@/components/dialogs";
import { Chip, ChipGroup, Drawer, Empty, ErrorBlock, ListBar, Notice, PageHead, Popover, TableSkeleton, Tabs } from "@/components/kit";
import { Button, buttonClass, Input } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { type AnnounceFilter, AnnounceDrawer } from "./_parts/Announce";
import { BulkCouponDialog, BulkResultDrawer, BulkTrialDialog, namesOf } from "./_parts/Bulk";
import styles from "./_parts/bulk.module.css";
import { healthTone, planLabel, useFmt } from "./_parts/format";
import type { BulkAction, BulkFilter, BulkResult, BulkTarget, Integration, Overview, WsList, WsRow } from "./_parts/types";

const PLANS = ["", "free", "team_s", "team_m", "team_l", "enterprise"] as const;
const SORTS = ["recent_activity", "mrr", "health", "newest"] as const;
const FEATURES = ["line", "webhook", "github", "api_token", "automation", "import", "no_project"] as const;
/** แท็บสถานะ · ค่าเดียวกับตัวกรอง status ของ ops-api (trialing / past_due = สถานะแพ็กเกจ) */
const STATUSES = ["", "active", "trialing", "past_due", "suspended"] as const;
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
  const [q, setQ] = useState("");
  const [plan, setPlan] = useState(params?.get("plan") ?? "");
  const [status, setStatus] = useState(params?.get("status") ?? "");
  const [peek, setPeek] = useState<string | null>(null);
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
  useEffect(() => setOffset(0), [search, plan, sort, feature, status]);
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
  const clear = () => (setQ(""), setPlan(""), setFeature(""), setStatus(""));
  const extraFilters = (plan ? 1 : 0) + (feature ? 1 : 0);
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
      {/* โครงหน้า Ops: แท็บสถานะ · ค้นหา · ตัวกรองอื่นอยู่ในปุ่ม "ตัวกรอง" (แพ็กเกจ / ฟีเจอร์เคยกินสองแถว) */}
      <ListBar
        tabs={
          <Tabs
            label={t("list.status")}
            value={(STATUSES as readonly string[]).includes(status) ? (status as (typeof STATUSES)[number]) : ""}
            onChange={setStatus}
            tabs={STATUSES.map((v) => ({ value: v, label: v ? t(`list.tabs.${v}`) : t("list.all") }))}
          />
        }
      >
        <Input aria-label={t("list.search")} placeholder={t("list.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        <Popover
          label={t("list.filters")}
          trigger={({ toggle, open }) => (
            <Button aria-expanded={open} onClick={toggle}>
              <SlidersHorizontal size={14} aria-hidden="true" /> {extraFilters ? t("list.filtersOn", { n: extraFilters }) : t("list.filters")}
            </Button>
          )}
        >
          {() => (
            <div className="stack" style={{ padding: 8, gap: 12 }}>
              <ChipGroup className="row" role="group" aria-label={t("list.plan")}>
                <span className="muted small" style={{ width: "100%" }}>
                  {t("list.plan")}
                </span>
                {PLANS.map((p) => (
                  <Chip key={p || "all"} pressed={plan === p} onClick={() => setPlan(p)}>
                    {p ? planLabel(p) : t("list.all")}
                  </Chip>
                ))}
              </ChipGroup>
              <div className="row" role="group" aria-label={t("list.feature")}>
                <span className="muted small" style={{ width: "100%" }}>
                  {t("list.feature")}
                </span>
                {FEATURES.map((f) => (
                  <Chip key={f} pressed={feature === f} onClick={() => setFeature(feature === f ? "" : f)}>
                    {t(`list.features.${f}`)}
                  </Chip>
                ))}
              </div>
            </div>
          )}
        </Popover>
        <select className="input" style={{ width: "auto" }} aria-label={t("list.sort")} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          {SORTS.filter((s) => s !== "mrr" || money).map((s) => (
            <option key={s} value={s}>
              {t(`list.sorts.${s}`)}
            </option>
          ))}
        </select>
      </ListBar>
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
                    <th>{t("list.plan")}</th>
                    <th>{t("list.col.status")}</th>
                    <th className="num">{t("list.col.seats")}</th>
                    <th className="num">{t("list.col.active")}</th>
                    <th className="num">{t("list.col.health")}</th>
                    {money && <th className="num">{t("list.col.mrr")}</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="row-link" aria-selected={peek === r.id} onClick={() => setPeek(r.id)}>
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
                          <span className="cell-sub">{r.slug}</span>
                        </button>
                      </td>
                      <td className="nowrap">{planLabel(r.plan)}</td>
                      <td>
                        <span className={r.status === "suspended" ? "pill bad" : r.paymentState === "overdue" || r.subStatus === "past_due" ? "pill warn" : r.subStatus === "active" ? "pill ok" : "pill"}>
                          {r.status === "suspended" ? (r.suspensionMode ? t(`list.suspendedMode.${r.suspensionMode}`) : t("wsStatus.suspended")) : t(`subStatus.${r.subStatus ?? "none"}`)}
                        </span>
                      </td>
                      <td className="num">{r.seatLimit ? `${r.seats} / ${r.seatLimit}` : r.seats}</td>
                      <td className="num">{r.active30}</td>
                      <td className="num">
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
      </div>
      <WsPeek id={peek} row={rows.find((r) => r.id === peek) ?? null} onClose={() => setPeek(null)} />
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
function WsPeek({ id, row, onClose }: { id: string | null; row: WsRow | null; onClose: () => void }) {
  const t = useTranslations("customers");
  const fmt = useFmt();
  const me = useMe().data;
  const q = useQuery({ queryKey: ["ops", "workspace", id], queryFn: () => api.get<Overview>(`/workspaces/${id}`), enabled: !!id });
  const o = q.data;
  const sub = o?.subscription;
  const owner = o?.owners.find((x) => x.role === "owner");
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
            </div>
            {!o.supportAccess?.active && <Notice tone="warn">{t("peek.noAccess")}</Notice>}
            <table className="tbl">
              <tbody>
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
