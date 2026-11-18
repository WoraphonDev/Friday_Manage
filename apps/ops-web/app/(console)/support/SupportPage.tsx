"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip, Play, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { clsx } from "clsx";
import { useTranslations } from "next-intl";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { Kbd } from "@/components/shortcut-help";
import { defer, UNDO_MS } from "@/lib/outbox";
import { type Seen, usePresence, usePresenceOf } from "@/lib/presence";
import { hasAny, initials } from "@/components/access";
import { Chip, ChipGroup, Drawer, Empty, ErrorBlock, ListBar, Modal, Notice, PageHead, Pager, Seg, TableSkeleton, Tabs } from "@/components/kit";
import { Button, buttonClass, errorToast, InlineError, Input, Select, Textarea, useToast } from "@/components/ui";
import { api, OPS_BASE } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useRowNav, useShortcuts, useStableRows } from "@/lib/shortcuts";
import { NewItemsBar } from "@/components/new-items";
import { useUrlFilters } from "@/lib/url-state";
import { ActiveFilters, FilterButton, filterKeys, filterQuery } from "@/components/filters";
import { ViewsBar } from "@/components/views-bar";
import { TICKET_SORTS, useTicketFilters } from "./_parts/filters";
import { BulkDialog, type BulkKind, IncidentLink } from "./_parts/Bulk";
import bulkStyles from "../workspaces/_parts/bulk.module.css";
import { planLabel, useFmt } from "../workspaces/_parts/format";
import { DevCard } from "../bugs/_components/DevCard";
import { EscalateDialog } from "../bugs/_components/EscalateDialog";
import { BackNotice, CannedPicker, MyPresence, SettingsLink, TeamNow } from "./settings/_parts/Live";
import { CATEGORIES, type Dur } from "./settings/_parts/types";

interface TicketRow {
  id: string;
  number: number;
  subject: string;
  status: string;
  priority: string;
  channel: string;
  requesterEmail: string | null;
  createdAt: string;
  firstResponseDueAt: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  workspace: { id: string; slug: string; name: string } | null;
  slaBreached: boolean;
  incident?: { id: string; title: string; status: string } | null;
}
interface Summary {
  open: number;
  unassigned: number;
  breached: number;
  firstResponseMinutes: number | null;
  csat: number | null;
}
interface TicketDetail {
  ticket: TicketRow & {
    cause: string | null;
    csat: number | null;
    category: string | null;
    requesterName: string | null;
    assignee: { id: string; name: string } | null;
    requesterEmail: string | null;
  };
  messages: {
    id: string;
    authorKind: "customer" | "staff" | "system";
    body: string;
    internal: boolean;
    createdAt: string;
    authorName: string | null;
    /** S6 · ไฟล์แนบที่ลูกค้าส่งมา (ไม่มี key ของที่เก็บ · ดาวน์โหลดผ่าน ops-api) */
    files?: { index: number; name: string; size: number; mime: string }[];
  }[];
  /** S6 · บริบทจากแอปลูกค้า (A44) */
  context?: {
    page: string | null;
    path: string | null;
    requestId: string | null;
    impact: "me" | "team" | "blocked" | null;
    browser: string | null;
    article: { slug: string | null; title: string | null } | null;
  } | null;
  customer: {
    id: string;
    slug: string;
    name: string;
    plan: string | null;
    seatLimit: number | null;
    seats: number;
    tickets90d: number;
    unhappy90d: number;
    accessUntil: string | null;
    accessGranted: boolean;
    accountManager: string | null;
    sla: { first: Dur | null; resolve: Dur | null };
    /** ช่วง 3 · contract = SLA ตามสัญญาของบัญชีลูกค้า */
    slaSource?: "plan" | "contract";
    account?: { id: string; name: string; kind: "standard" | "enterprise"; managerName: string | null; workspaces: number; openTickets: number } | null;
  } | null;
}
const key = ["ops", "tickets"] as const;
const invalidate = (cache: ReturnType<typeof useQueryClient>) => void cache.invalidateQueries({ queryKey: ["ops"] });

/**
 * หน้า 6 · Ticket (Support.dc.html · ปรับตามโครงหน้า Ops 18 พ.ย. 2569):
 * คิวของฉันเต็มความกว้าง · กดแถวเปิดบทสนทนาแบบแชทในแผงขวา · ทีมตอนนี้ / คิวกลาง / ผลงานรายคนอยู่แท็บ "ทีม"
 * การเข้าช่วยเหลือมีเมนูของตัวเอง (/support/sessions) จึงไม่วางซ้ำที่นี่
 */
type Queue = "mine" | "none" | "all" | "team";
/** ช่วง 2 · ตอบต่อเนื่อง */
interface RunItem {
  id: string;
  number: number;
}
interface RunState {
  items: RunItem[];
  i: number;
  /** ข้ามเอง หรือข้ามเพราะเพื่อนเปิดอยู่ (by) */
  skipped: (RunItem & { by?: string })[];
  note: string | null;
  replied: number;
  closed: number;
  started: number;
  finished: boolean;
  label: string;
  draft?: { id: string; text: string } | null;
}
interface RunView {
  pos: number;
  total: number;
  label: string;
  note: string | null;
  onEvent: (kind: "replied" | "closed" | "skipped") => void;
  onStop: () => void;
  /** กด "ย้อนกลับ" หลังส่ง: กลับไปเรื่องนั้นในลำดับเดิมพร้อมร่างเดิม */
  onBack: (id: string, text: string) => void;
  draft: { id: string; text: string } | null;
}
const PAGE = 50;
export function SupportPage() {
  const t = useTranslations("ss.support");
  const tb = useTranslations("bugs.support");
  const params = useSearchParams();
  const router = useRouter();
  const fmt = useFmt();
  const me = useMe().data;
  const support = hasAny(me, "support");
  // คนตอบ Ticket เริ่มที่คิวของตัวเอง · บทบาทอื่น (Owner / ผู้ตรวจ) เริ่มที่ทั้งหมด
  // ตัวกรองอยู่ใน URL (กดย้อนกลับแล้วยังอยู่ที่เดิม · ส่งลิงก์ได้) · queue ว่าง = ตามบทบาท
  // ช่วง 3: แผงตัวกรอง + เรียง · อยู่ใน URL เหมือนกันจึงบันทึกเป็นมุมมองได้
  const defs = useTicketFilters();
  const defaults = { tab: "", status: "active", q: "", sort: "sla", ...filterKeys(defs) };
  const [f, setF] = useUrlFilters(defaults);
  const fq = filterQuery(defs, f);
  const setFilters = (patch: Record<string, string>) => (setF(patch), setOffset(0));
  const queue: Queue = (["mine", "none", "all", "team"] as const).includes(f.tab as Queue) ? (f.tab as Queue) : support ? "mine" : "all";
  const setQueue = (v: Queue) => (setF({ tab: v }), setOffset(0));
  const status = f.status as "active" | "pending_dev" | "solved" | "closed";
  const setStatus = (v: typeof status) => (setF({ status: v }), setOffset(0));
  const [q, setQ] = useState(f.q);
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const search = useDeferredValue(q.trim());
  useEffect(() => {
    if (search !== f.q) (setF({ q: search }), setOffset(0));
    // เขียน URL เมื่อคำค้นนิ่งแล้วเท่านั้น
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  const listQueue = queue === "team" ? "all" : queue;
  const filter = new URLSearchParams({
    status,
    limit: String(PAGE),
    offset: String(offset),
    // ops-api รับ assignee = me | none | uuid (เคยส่ง "mine" จนแท็บ "ของฉัน" โหลดไม่ได้)
    ...(listQueue !== "all" ? { assignee: listQueue === "mine" ? "me" : listQueue } : {}),
    ...(search ? { q: search } : {}),
    ...fq,
    ...(f.sort !== "sla" ? { sort: f.sort } : {}),
    ...(params?.get("workspace") ? { workspaceId: params.get("workspace")! } : {}),
  });
  const list = useQuery({
    queryKey: [...key, filter.toString()],
    queryFn: () => api.get<{ items: TicketRow[]; total: number; counts: { mine: number; none: number; all: number }; summary: Summary }>(`/tickets?${filter}`),
    placeholderData: keepPreviousData,
    // ช่วง 2: เช็กเรื่องใหม่ทุก 30 วินาที · แถวใหม่รอกด "แสดง" (ไม่แทรกเอง)
    refetchInterval: 30_000,
  });
  const stable = useStableRows(list.data?.items, filter.toString());
  const selected = params?.get("ticket") ?? null;
  // เปิด / ปิดแผง Ticket คงตัวกรองเดิมไว้ใน URL
  const select = (id: string | null) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    if (id) next.set("ticket", id);
    else next.delete("ticket");
    const s = next.toString();
    router.replace(s ? `/support?${s}` : "/support");
  };
  const s = list.data?.summary;
  const tk = useTranslations("common.keys");
  const tr = useTranslations("ss.support.run");
  const toast = useToast();
  // ---- ช่วง 2 · ตอบต่อเนื่อง: หยิบเรื่องตามลำดับในแท็บที่เปิดอยู่ (SLA ใกล้หมดก่อน) · ข้ามเรื่องที่เพื่อนเปิดอยู่
  const [run, setRun] = useState<RunState | null>(null);
  const goTo = async (r: RunState, from: number, extraSkipped: RunState["skipped"] = []) => {
    const rest = r.items.slice(from, from + 50);
    const seen = rest.length ? (await api.get<{ items: Seen[] }>(`/presence?type=ticket&ids=${rest.map((x) => x.id).join(",")}`).catch(() => ({ items: [] as Seen[] }))).items : [];
    const busy = new Map(seen.map((x) => [x.id, x.name]));
    let i = from;
    const now: RunState["skipped"] = [];
    while (i < r.items.length && busy.has(r.items[i].id)) {
      now.push({ ...r.items[i], by: busy.get(r.items[i].id) });
      i++;
    }
    const next: RunState = {
      ...r,
      i,
      skipped: [...r.skipped, ...extraSkipped, ...now],
      note: now.length ? tr("skippedViewed", { numbers: now.map((x) => `#${x.number}`).join(", "), name: now[0].by ?? "" }) : null,
      finished: i >= r.items.length,
    };
    setRun(next);
    if (next.finished) select(null);
    else select(r.items[i].id);
  };
  const startRun = async (from: Queue = queue, items?: RunItem[]) => {
    const asked = new URLSearchParams(filter);
    asked.set("limit", "200");
    asked.set("offset", "0");
    if (from === "none") asked.set("assignee", "none");
    const picked = items ?? (await api.get<{ items: TicketRow[] }>(`/tickets?${asked}`)).items.map((k) => ({ id: k.id, number: k.number }));
    if (!picked.length) return toast(tr("empty"));
    await goTo({ items: picked, i: 0, skipped: [], note: null, replied: 0, closed: 0, started: Date.now(), finished: false, label: t(`queues.${from === "team" ? "all" : from}`) }, 0);
  };
  const runEvent = (kind: "replied" | "closed" | "skipped") => {
    if (!run) return;
    const r = { ...run, replied: run.replied + (kind === "replied" ? 1 : 0), closed: run.closed + (kind === "closed" ? 1 : 0) };
    void goTo(r, run.i + 1, kind === "skipped" ? [run.items[run.i]] : []);
  };
  const runBack = (id: string, text: string) => {
    setRun((r) => {
      if (!r) return r;
      const i = r.items.findIndex((x) => x.id === id);
      return i < 0 ? r : { ...r, i, finished: false, replied: Math.max(0, r.replied - 1), note: null, draft: { id, text } };
    });
    select(id);
  };
  const stopRun = () => {
    if (!run) return;
    select(null);
    setRun({ ...run, finished: true });
  };
  useShortcuts([{ keys: "p", label: tr("start"), list: true, run: () => void (queue !== "team" && startRun()) }], support);
  const viewers = usePresenceOf("ticket", queue === "team" ? [] : stable.rows.map((k) => k.id));
  // ---- ช่วง 3 · เลือกหลายเรื่อง: ติ๊กทีละแถว / ทั้งหน้า / ทั้งหมดตามตัวกรอง (ไม่เกิน 1,000) · เปลี่ยนตัวกรองแล้วล้างที่เลือก
  const [picked, setPicked] = useState<Map<string, number>>(new Map());
  const [byFilter, setByFilter] = useState(false);
  const [bulk, setBulk] = useState<BulkKind | null>(null);
  const scope = JSON.stringify({ fq, status, search, queue });
  useEffect(() => (setPicked(new Map()), setByFilter(false)), [scope]);
  const pageRows = stable.rows;
  const pageAll = pageRows.length > 0 && pageRows.every((k) => picked.has(k.id));
  const pageSome = pageRows.some((k) => picked.has(k.id));
  const headBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headBox.current) headBox.current.indeterminate = pageSome && !pageAll;
  }, [pageSome, pageAll]);
  const pick = (k: { id: string; number: number }, on: boolean) => {
    const next = new Map(picked);
    if (on) next.set(k.id, k.number);
    else next.delete(k.id);
    setPicked(next);
    setByFilter(false);
  };
  const pickPage = (on: boolean) => {
    const next = new Map(picked);
    for (const k of pageRows) {
      if (on) next.set(k.id, k.number);
      else next.delete(k.id);
    }
    setPicked(next);
    setByFilter(false);
  };
  const totalRows = list.data?.total ?? 0;
  const bulkFilter: Record<string, string> = { ...fq, status, ...(search ? { q: search } : {}), ...(queue !== "team" ? { tab: queue } : {}), ...(params?.get("workspace") ? { workspaceId: params.get("workspace")! } : {}) };
  const bulkTarget = byFilter ? { filter: bulkFilter } : { ids: [...picked.keys()] };
  const bulkCount = byFilter ? totalRows : picked.size;
  const tbk = useTranslations("ss.support.bulk");
  const nav = useRowNav(queue === "team" ? [] : stable.rows, { onOpen: (k) => select(k.id), labels: { down: tk("down"), open: tk("open") } });
  const count = (n: number | undefined) => (n ? <span className="tab-count">{n}</span> : null);
  return (
    <>
      <PageHead
        title={t("title")}
        desc={
          s
            ? t("summary", {
                open: s.open,
                unassigned: s.unassigned,
                breached: s.breached,
                first: s.firstResponseMinutes == null ? t("na") : t("minutes", { n: s.firstResponseMinutes }),
                csat: s.csat == null ? t("na") : `${s.csat}/5`,
              })
            : undefined
        }
        actions={
          <>
            <MyPresence />
            <SettingsLink />
            {support && queue !== "team" && (
              <Button onClick={() => void startRun()}>
                <Play size={14} aria-hidden="true" /> {tr("start")}
              </Button>
            )}
            {support && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus size={16} /> {t("create")}
              </Button>
            )}
          </>
        }
      />
      <BackNotice />
      <ListBar
        tabs={
          <Tabs
            label={t("title")}
            value={queue}
            onChange={setQueue}
            tabs={(support ? (["mine", "none", "all", "team"] as const) : (["all", "none", "team"] as const)).map((v) => ({
              value: v,
              label: (
                <>
                  {t(`queues.${v}`)}
                  {v !== "team" && count(list.data?.counts?.[v])}
                </>
              ),
            }))}
          />
        }
      >
        {queue !== "team" && (
          <>
            <Input data-page-search aria-label={t("search")} placeholder={t("search")} value={q} onChange={(e) => setQ(e.target.value)} />
            <FilterButton defs={defs} values={f} onChange={setFilters} />
            <select className="input" style={{ width: "auto" }} aria-label={t("sortLabel")} value={f.sort} onChange={(e) => setFilters({ sort: e.target.value })}>
              {TICKET_SORTS.map((v) => (
                <option key={v} value={v}>
                  {t(`sorts.${v}`)}
                </option>
              ))}
            </select>
          </>
        )}
      </ListBar>
      {queue === "team" ? (
        <>
          <TeamNow />
          <Stats />
        </>
      ) : (
        <>
          <ViewsBar page="tickets" values={f} defaults={defaults} onApply={(v) => (setQ(v.q ?? ""), setF({ ...defaults, ...v }), setOffset(0))} />
          <ActiveFilters defs={defs} values={f} onChange={setFilters} />
          <NewItemsBar count={stable.fresh} onShow={stable.reveal} />
          {support && (picked.size > 0 || byFilter) && (
            <div className={`${bulkStyles.bar} motion-in`} role="status">
              <b>{byFilter ? tbk("selectedFilter", { n: totalRows }) : tbk("selected", { n: picked.size })}</b>
              {byFilter ? (
                <button type="button" className={bulkStyles.link} onClick={() => setByFilter(false)}>
                  {tbk("onlyPicked")}
                </button>
              ) : (
                totalRows > picked.size && (
                  <button type="button" className={bulkStyles.link} disabled={totalRows > 1000} title={totalRows > 1000 ? tbk("max") : undefined} onClick={() => setByFilter(true)}>
                    {tbk("selectByFilter", { n: totalRows })}
                  </button>
                )
              )}
              {totalRows > 1000 && !byFilter && <span className={bulkStyles.hint}>{tbk("max")}</span>}
              <span className={bulkStyles.actions}>
                {(["reply", "assign", "solve", "priority", "incident"] as const).map((k) => (
                  <Button key={k} size="small" onClick={() => setBulk(k)}>
                    {tbk(`kinds.${k}`)}
                  </Button>
                ))}
                <Button size="small" variant="ghost" onClick={() => (setPicked(new Map()), setByFilter(false))}>
                  {tbk("clear")}
                </Button>
              </span>
            </div>
          )}
          <ChipGroup className="row">
            {(["active", "pending_dev", "solved", "closed"] as const).map((v) => (
              <Chip key={v} pressed={status === v} onClick={() => setStatus(v)}>
                {/* O36 · แท็บ "รอทีมพัฒนา" (Ticket สถานะ pending_dev) */}
                {v === "pending_dev" ? tb("pendingDev") : t(`statusFilter.${v}`)}
              </Chip>
            ))}
          </ChipGroup>
          {list.isPending ? (
            <TableSkeleton rows={5} cols={6} />
          ) : list.error ? (
            <ErrorBlock error={list.error} retry={() => void list.refetch()} />
          ) : !stable.rows.length && !stable.fresh ? (
            // มีตัวกรองอยู่ = ไม่ใช่ "คิวว่าง" จริง จึงไม่ขึ้นข้อความแบบเสร็จงาน
            Object.keys(fq).length ? (
              <Empty title={t("empty")} />
            ) : (
              <Empty ok={queue === "none" || queue === "mine"} title={queue === "none" ? t("emptyQueue") : queue === "mine" ? t("emptyMine") : t("empty")} />
            )
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    {support && (
                      <th>
                        <input ref={headBox} type="checkbox" aria-label={tbk("selectPage")} checked={pageAll || (byFilter && pageRows.length > 0)} disabled={byFilter} onChange={(e) => pickPage(e.target.checked)} />
                      </th>
                    )}
                    <th scope="col">{t("col.ticket")}</th>
                    <th scope="col">{t("col.customer")}</th>
                    <th scope="col">{t("col.status")}</th>
                    <th scope="col">{t("col.assignee")}</th>
                    <th scope="col">{t("col.due")}</th>
                  </tr>
                </thead>
                <tbody className="motion-list">
                  {stable.rows.map((k, i) => (
                    <tr key={k.id} className="row-link" aria-selected={selected === k.id} onClick={() => select(k.id)} {...nav.rowProps(i)}>
                      {support && (
                        <td onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" aria-label={tbk("selectRow", { number: k.number })} checked={byFilter || picked.has(k.id)} disabled={byFilter} onChange={(e) => pick(k, e.target.checked)} />
                        </td>
                      )}
                      <td>
                        <button type="button" className="row-link-button" onClick={(e) => (e.stopPropagation(), select(k.id))}>
                          <span className="row nowrap">
                            <b className="mono">#{k.number}</b>
                            <span>{k.subject}</span>
                          </span>
                        </button>
                        {viewers.get(k.id)?.slice(0, 1).map((v) => (
                          <span key={v.staffId} className="viewing">
                            ● {t(v.mode === "typing" ? "presence.typing" : "presence.viewing", { name: v.name })}
                          </span>
                        ))}
                        {k.incident && (
                          <>
                            {" "}
                            <span className="pill inf">{tbk("incidentPill", { title: k.incident.title })}</span>
                          </>
                        )}
                        {(k.priority === "urgent" || k.priority === "high") && (
                          <>
                            {" "}
                            <span className="pill bad">{t(`priority.${k.priority}`)}</span>
                          </>
                        )}
                      </td>
                      <td className="muted">{k.workspace?.name ?? k.requesterEmail}</td>
                      <td>
                        <span className="pill">{t(`status.${k.status}` as "status.open")}</span>
                      </td>
                      <td className={k.assigneeName ? undefined : "muted"}>{k.assigneeName ?? t("unassigned")}</td>
                      <td>{k.slaBreached ? <span className="pill warn">{t("breached")}</span> : k.firstResponseDueAt ? <span className="muted">{fmt.dateTime(k.firstResponseDueAt)}</span> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {list.data?.total != null && <Pager hotkeys offset={offset} limit={PAGE} shown={list.data.items.length} total={list.data.total} onChange={setOffset} />}
        </>
      )}
      {bulk && <BulkDialog target={bulkTarget} count={bulkCount} initial={bulk} onClose={() => setBulk(null)} onDone={() => (setBulk(null), setPicked(new Map()), setByFilter(false), void list.refetch())} />}
      <TicketDrawer
        id={selected}
        onClose={() => (run && !run.finished ? stopRun() : select(null))}
        run={run && !run.finished ? { pos: run.i + 1, total: run.items.length, label: run.label, note: run.note, onEvent: runEvent, onStop: stopRun, onBack: runBack, draft: run.draft ?? null } : undefined}
      />
      {run?.finished && (
        <RunSummary
          run={run}
          unassigned={list.data?.counts?.none ?? 0}
          onSkipped={() => void startRun(queue, run.skipped.map(({ id, number }) => ({ id, number })))}
          onQueue={() => (setF({ tab: "none" }), void startRun("none"))}
          onClose={() => setRun(null)}
        />
      )}
      {creating && <CreateTicket onClose={() => setCreating(false)} onCreated={(id) => select(id)} />}
    </>
  );
}

/** แผงขวาของ Ticket: หัวข้อเป็นชื่อแผง · เนื้อหาเป็นแชท */
function TicketDrawer({ id, onClose, run }: { id: string | null; onClose: () => void; run?: RunView }) {
  const t = useTranslations("ss.support");
  // คีย์เดียวกับ TicketView จึงยิงครั้งเดียว · ใช้ทำชื่อแผง
  const detail = useQuery({ queryKey: [...key, "detail", id], queryFn: () => api.get<TicketDetail>(`/tickets/${id}`), enabled: !!id }).data;
  return (
    <Drawer open={!!id} onOpenChange={(o) => !o && onClose()} title={detail ? `#${detail.ticket.number} · ${detail.ticket.subject}` : t("ticket")} className="drawer-ticket">
      {id && <TicketView key={id} id={id} run={run} />}
    </Drawer>
  );
}

function TicketView({ id, run }: { id: string; run?: RunView }) {
  const t = useTranslations("ss");
  const tset = useTranslations("sset");
  const tAcc = useTranslations("customers.accounts");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const me = useMe().data;
  const support = hasAny(me, "support");
  const q = useQuery({
    queryKey: [...key, "detail", id],
    queryFn: () => api.get<TicketDetail>(`/tickets/${id}`),
    // ช่วง 2: ระหว่างเปิดอยู่ เช็กข้อความใหม่จากเพื่อน / ลูกค้า
    refetchInterval: 10_000,
  });
  const tr = useTranslations("ss.support.run");
  const [mode, setMode] = useState<"reply" | "internal" | "customer">("reply");
  const [body, setBody] = useState(() => (run?.draft?.id === id ? run.draft.text : ""));
  const typing = body.trim().length > 0;
  // กำลังดูโดย: บอกเพื่อนว่าเปิด / พิมพ์อยู่ · เห็นเพื่อนที่อยู่เรื่องเดียวกัน
  const others = usePresence("ticket", id, typing ? "typing" : "viewing");
  const [watchOnly, setWatchOnly] = useState(false);
  const [dismissedTyping, setDismissedTyping] = useState(false);
  // ข้อความใหม่ของเพื่อนระหว่างที่เรากำลังพิมพ์ → เตือนให้อ่านก่อนส่ง
  const [baseCount, setBaseCount] = useState<number | null>(null);
  const [modal, setModal] = useState<"assign" | "escalate" | "solve" | null>(null);
  const act = useMutation({
    mutationFn: (action: "claim" | "release") => api.post(`/tickets/${id}/${action}`),
    onSuccess: (_r, a) => (toast(a === "claim" ? t("support.claimed") : t("support.released")), invalidate(cache)),
    onError: (e) => toast(errorToast(e)),
  });
  const send = useMutation({
    mutationFn: () =>
      api.post<{ reopened?: boolean }>(`/tickets/${id}/messages`, {
        body: body.trim(),
        internal: mode === "internal",
        fromCustomer: mode === "customer",
      }),
    onSuccess: (r) => (setBody(""), setBaseCount(null), toast(r.reopened ? t("support.reopened") : t("support.sent")), invalidate(cache)),
  });
  // ตอบต่อเนื่อง (ข้อ 2 ก): ส่งจริงหลัง 10 วินาที ย้อนกลับได้ · ไปเรื่องถัดไปทันที
  const sendInRun = () => {
    const text = body.trim();
    const payload = { body: text, internal: mode === "internal", fromCustomer: mode === "customer" };
    const number = q.data?.ticket.number;
    const job = defer(`ticket:${id}`, () => api.post(`/tickets/${id}/messages`, payload).then(() => invalidate(cache)), (e) => toast(errorToast(e)));
    toast({
      message: tr("sent", { n: number ?? "" }),
      duration: UNDO_MS,
      undo: () => {
        // ยังไม่ถึงเวลา = ยกเลิกแล้วเปิดเรื่องเดิมพร้อมร่าง
        if (job.cancel()) run!.onBack(id, text);
      },
    });
    run!.onEvent("replied");
  };
  const submit = () => {
    if (!body.trim() || send.isPending) return;
    if (run && mode === "reply") sendInRun();
    else send.mutate();
  };
  const unassigned = !!q.data && !q.data.ticket.assignee && q.data.ticket.status !== "closed";
  const msgCount = q.data?.messages.length ?? 0;
  useEffect(() => {
    // ข้อ 1 ก: เริ่มพิมพ์ตอบเรื่องที่ยังไม่มีคนรับ = รับเรื่องให้อัตโนมัติ (เพื่อนจะไม่หยิบซ้ำ)
    if (typing && unassigned && support && mode === "reply" && !act.isPending) act.mutate("claim");
    if (typing && baseCount == null) setBaseCount(msgCount);
    if (!typing && baseCount != null) setBaseCount(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typing]);
  useShortcuts([
    { keys: "mod+enter", label: t("support.send"), inInput: true, run: () => submit() },
    { keys: "shift+mod+enter", label: tr("sendClose"), inInput: true, run: () => body.trim() && setModal("solve") },
    ...(run ? [{ keys: "s", label: tr("skip"), run: () => run.onEvent("skipped") }] : []),
  ]);
  if (q.isPending)
    return (
      <div className="ticket-head">
        <TableSkeleton rows={4} cols={1} />
      </div>
    );
  if (q.error)
    return (
      <div className="ticket-head">
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      </div>
    );
  const { ticket: k, messages, customer, context } = q.data;
  const categoryLabel = (c: string) => ((CATEGORIES as readonly string[]).includes(c) ? tset(`category.${c as (typeof CATEGORIES)[number]}`) : c);
  const closed = k.status === "closed";
  const mine = k.assignee?.id === me?.id;
  const actions = support && !closed && (
    <div className="row">
      {!k.assignee && (
        <Button variant="primary" size="small" disabled={act.isPending} onClick={() => act.mutate("claim")}>
          {t("support.claim")}
        </Button>
      )}
      {(mine || hasAny(me, "owner") || !k.assignee) && (
        <Button size="small" onClick={() => setModal("assign")}>
          {t("support.assign")}
        </Button>
      )}
      {k.status !== "pending_dev" && k.status !== "solved" && (
        <Button size="small" onClick={() => setModal("escalate")}>
          {t("support.escalate")}
        </Button>
      )}
      {mine && (
        <Button variant="ghost" size="small" disabled={act.isPending} onClick={() => act.mutate("release")}>
          {t("support.release")}
        </Button>
      )}
      {k.status !== "solved" && (
        <Button size="small" onClick={() => setModal("solve")}>
          {t("support.solve")}
        </Button>
      )}
    </div>
  );
  const placeholder = mode === "reply" ? t("support.reply") : mode === "internal" ? t("support.internal") : t("support.fromCustomer");
  const typer = others.find((o) => o.mode === "typing");
  const viewer = others[0];
  const fresh = baseCount != null ? messages.slice(baseCount).filter((m) => m.authorKind === "staff" && m.authorName && m.authorName !== me?.name) : [];
  return (
    <>
      {run && (
        <div className="run-bar" role="status">
          <span className="muted small">{tr("progress", { label: run.label, pos: run.pos, total: run.total })}</span>
          <span className="run-progress" aria-hidden="true">
            <i style={{ width: `${Math.round((run.pos / run.total) * 100)}%` }} />
          </span>
          <Button size="small" onClick={() => run.onEvent("skipped")}>
            {tr("skip")} <Kbd keys="s" />
          </Button>
          <Button size="small" onClick={run.onStop}>
            {tr("stop")} <Kbd keys="escape" />
          </Button>
          {run.note && <span className="run-note">{run.note}</span>}
        </div>
      )}
      <div className="ticket-head">
        {typer && !dismissedTyping ? (
          <div className="presence-banner warn" role="status">
            <span aria-hidden="true">●</span>
            <span>{t("support.presence.typingBanner", { name: typer.name })}</span>
            <span className="row" style={{ marginLeft: "auto" }}>
              <Button size="small" onClick={() => (setWatchOnly(true), setDismissedTyping(true))}>
                {t("support.presence.watch")}
              </Button>
              <Button size="small" onClick={() => setDismissedTyping(true)}>
                {t("support.presence.replyAnyway")}
              </Button>
            </span>
          </div>
        ) : (
          viewer && !typer && <p className="muted small">● {t("support.presence.viewingNote", { name: viewer.name })}</p>
        )}
        <div className="row small">
          <span className="pill">{t(`support.status.${k.status}` as "support.status.open")}</span>
          <span className={k.priority === "urgent" || k.priority === "high" ? "pill bad" : "pill"}>{t(`support.priority.${k.priority}` as "support.priority.normal")}</span>
          <span className="pill">{t(`support.channel.${k.channel}` as "support.channel.email")}</span>
          {k.category && <span className="pill">{categoryLabel(k.category)}</span>}
          {k.slaBreached ? (
            <span className="pill warn">{t("support.breached")}</span>
          ) : (
            k.firstResponseDueAt && <span className="muted">{t("support.dueIn", { time: fmt.dateTime(k.firstResponseDueAt) })}</span>
          )}
          <span className="muted">
            {t("support.assignee")}: {k.assignee?.name ?? t("support.unassigned")}
          </span>
          <IncidentLink ticketId={k.id} incident={k.incident ?? null} canEdit={hasAny(me, "support", "owner") && k.status !== "closed"} />
        </div>
        {actions}
      </div>
      <div className="ticket-body">
        <div className="chat-col">
          {/* แชท: ลูกค้าซ้าย · ทีมเราขวาสีม่วง · บันทึกภายในขวาสีเหลือง · เหตุการณ์ของระบบเป็นบรรทัดกลาง */}
          <ol className="chat-thread" aria-label={t("support.thread")}>
            {messages.map((m) => {
              const systemLine = m.authorKind === "system" || (m.authorKind === "staff" && !m.authorName && m.internal);
              if (systemLine)
                return (
                  <li key={m.id} className="chat-system">
                    <b>{t("support.system")}</b>
                    <span>{m.body}</span>
                    <span>· {fmt.dateTime(m.createdAt)}</span>
                  </li>
                );
              const them = m.authorKind === "customer";
              const who = m.authorKind === "staff" && !m.authorName ? t("support.auto") : (m.authorName ?? k.requesterName ?? k.requesterEmail);
              return (
                <li key={m.id} className={clsx("bubble", them ? "bubble-them" : "bubble-mine", m.internal && "bubble-note")}>
                  <span className="avatar avatar-sm" aria-hidden="true">
                    {initials(who ?? "?")}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="bubble-who">
                      {m.internal && <span className="pill warn">{t("support.internalTag")}</span>}
                      <b>{who}</b>
                      <span>{fmt.dateTime(m.createdAt)}</span>
                    </div>
                    <div className="bubble-text">{m.body}</div>
                    {!!m.files?.length && (
                      <ul className="bubble-files" aria-label={t("support.files")}>
                        {m.files.map((f) => (
                          <li key={f.index}>
                            <a href={`${OPS_BASE}/tickets/${k.id}/messages/${m.id}/files/${f.index}`} target="_blank" rel="noreferrer">
                              <Paperclip size={14} aria-hidden="true" /> {t("support.file", { name: f.name, size: fileSize(f.size) })}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          {support && !closed && watchOnly && (
            <div className="composer">
              <Button size="small" onClick={() => setWatchOnly(false)}>
                {t("support.presence.startReply")}
              </Button>
            </div>
          )}
          {support && !closed && !watchOnly && (
            <form className={clsx("composer", mode === "internal" && "composer-note")} onSubmit={(e) => (e.preventDefault(), submit())}>
              {fresh.length > 0 && typing && (
                <div className="presence-banner info" role="status">
                  <span aria-hidden="true">ⓘ</span>
                  <span>{t("support.presence.newReply", { name: fresh[fresh.length - 1].authorName! })}</span>
                  <Button size="small" variant="ghost" style={{ marginLeft: "auto" }} onClick={() => setBaseCount(msgCount)}>
                    {t("support.presence.read")}
                  </Button>
                </div>
              )}
              <div className="composer-tools">
                <Seg label={t("support.reply")} value={mode} onChange={setMode} options={(["reply", "internal", "customer"] as const).map((v) => ({ value: v, label: t(`support.modes.${v}`) }))} />
                {mode === "reply" ? (
                  <CannedPicker
                    vars={{ requester: k.requesterName ?? k.requesterEmail ?? "", workspace: customer?.name ?? "", ticket: k.number }}
                    onInsert={(text) => setBody((b) => (b.trim() ? `${b.trimEnd()}\n\n${text}` : text))}
                  />
                ) : (
                  <span />
                )}
              </div>
              <div className="composer-input">
                <Textarea
                  aria-label={placeholder}
                  placeholder={placeholder}
                  value={body}
                  rows={2}
                  onChange={(e) => setBody(e.target.value)}
                  // ตอบต่อเนื่อง: เคอร์เซอร์อยู่ในช่องตอบทันที · ⌘↵ ส่ง (ปุ่มลัด) · Enter อย่างเดียวขึ้นบรรทัดใหม่
                  autoFocus={!!run}
                />
                <Button type="submit" variant="primary" disabled={!body.trim() || send.isPending}>
                  {t("support.send")} <Kbd keys="mod+enter" />
                </Button>
              </div>
              <InlineError error={send.error} />
            </form>
          )}
        </div>
        <div className="ticket-info">
          {context && <ContextCard context={context} />}
          <aside className="card" aria-label={t("support.customer")}>
            <h3 className="card-title">{customer?.name ?? t("support.customer")}</h3>
            {customer?.account && (
              <div className="stack small" style={{ gap: 2, marginBottom: 8 }}>
                <Link className="link-button" href={`/accounts/${customer.account.id}`}>
                  <b>{t("support.account.label", { name: customer.account.name })}</b>
                </Link>
                <span className="muted">{t("support.account.meta", { kind: tAcc(`kind.${customer.account.kind}`), n: customer.account.workspaces })}</span>
                {customer.account.managerName && <span>{t("support.account.manager", { name: customer.account.managerName })}</span>}
                {customer.slaSource === "contract" && customer.sla.first && <span>{t("support.account.slaContract", { n: customer.sla.first.n, unit: customer.sla.first.unit === "h" ? t("support.account.h") : t("support.account.d") })}</span>}
                {customer.account.workspaces > 1 && (
                  <Link className="muted" href={`/support?tab=all&account=${customer.account.id}`}>
                    {t("support.account.open", { n: customer.account.openTickets })}
                  </Link>
                )}
              </div>
            )}
            {customer ? (
              <table className="tbl">
                <tbody>
                  <tr>
                    <td className="muted">{t("support.plan")}</td>
                    <td>
                      {planLabel(customer.plan)} · {t("support.seats", { seats: customer.seats, limit: customer.seatLimit ?? "∞" })}
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">{customer.slaSource === "contract" ? t("support.slaContractLabel") : t("support.sla")}</td>
                    <td>{customer.sla.first ? t("support.slaValue", { n: customer.sla.first.n, unit: customer.sla.first.unit }) : t("support.slaNone")}</td>
                  </tr>
                  <tr>
                    <td className="muted">{t("support.accountManager")}</td>
                    <td>{customer.accountManager ?? "—"}</td>
                  </tr>
                  <tr>
                    <td className="muted">{t("support.tickets90")}</td>
                    <td>{t("support.tickets90Value", { n: customer.tickets90d, bad: customer.unhappy90d })}</td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <p className="muted small">{t("support.noWs")}</p>
            )}
            {customer &&
              (customer.accessGranted ? (
                <Notice tone="info">{t("support.access", { until: customer.accessUntil ? fmt.date(customer.accessUntil) : t("support.accessForever") })}</Notice>
              ) : (
                <Notice tone="warn">{t("support.noAccess")}</Notice>
              ))}
            {customer && (
              <Link className={buttonClass("ghost", "small")} href={`/workspaces/${customer.id}`}>
                {t("support.openCustomer")}
              </Link>
            )}
          </aside>
          {/* O36 · T8 งานของทีมพัฒนาที่ผูกกับ Ticket นี้ */}
          <DevCard ticketId={id} number={k.number} />
        </div>
      </div>
      {modal === "assign" && <AssignDialog id={id} onClose={() => setModal(null)} />}
      {/* O36 · T3 ปรับ: สร้าง / ผูกงานใน FM (ยังไม่ตั้งค่า = ส่งต่อแบบเดิม) */}
      {modal === "escalate" && <EscalateDialog ticket={{ id, number: k.number, subject: k.subject }} onClose={() => setModal(null)} />}
      {modal === "solve" && (
        <SolveDialog
          id={id}
          number={k.number}
          initialOutcome={body.trim()}
          onClose={() => setModal(null)}
          onSolved={() => (setBody(""), run?.onEvent("closed"))}
        />
      )}
    </>
  );
}

/** สรุปเมื่อจบการตอบต่อเนื่อง (ช่วง 2) */
function RunSummary({ run, unassigned, onSkipped, onQueue, onClose }: { run: RunState; unassigned: number; onSkipped: () => void; onQueue: () => void; onClose: () => void }) {
  const t = useTranslations("ss.support.run");
  const minutes = Math.max(1, Math.round((Date.now() - run.started) / 60_000));
  const done = run.i >= run.items.length;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={done ? t("doneTitle", { n: run.items.length }) : t("stoppedTitle", { n: run.replied + run.closed })}>
      <div className="dialog-body">
        <div className="run-stats">
          <div>
            <span className="muted small">{t("replied")}</span>
            <b>{run.replied}</b>
          </div>
          <div>
            <span className="muted small">{t("closed")}</span>
            <b>{run.closed}</b>
          </div>
          <div>
            <span className="muted small">{t("skipped")}</span>
            <b>{run.skipped.length}</b>
          </div>
        </div>
        <p className="muted small">{t("took", { minutes })}</p>
        <div className="dialog-actions">
          <Button onClick={onClose}>{t("back")}</Button>
          {run.skipped.length > 0 && <Button onClick={onSkipped}>{t("doSkipped", { n: run.skipped.length })}</Button>}
          {unassigned > 0 && (
            <Button variant="primary" onClick={onQueue}>
              {t("fromQueue", { n: unassigned })}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

const fileSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** S6 · บริบทที่ลูกค้าส่งมากับ Ticket: หน้า · requestId (ค้นในประวัติการส่ง) · บทความ · เบราว์เซอร์ · ผลกระทบ */
function ContextCard({ context: c }: { context: NonNullable<TicketDetail["context"]> }) {
  const t = useTranslations("ss.support.context");
  return (
    <aside className="card" aria-label={t("title")}>
      <h3 className="card-title">{t("title")}</h3>
      <table className="tbl">
        <tbody>
          {(c.path || c.page) && (
            <tr>
              <td className="muted">{t("page")}</td>
              <td className="cell-wrap">
                <span className="mono small">{c.path ?? c.page}</span>
              </td>
            </tr>
          )}
          {c.requestId && (
            <tr>
              <td className="muted">{t("requestId")}</td>
              <td>
                <span className="mono small">{c.requestId}</span> <Link href={`/deliveries?q=${encodeURIComponent(c.requestId)}`}>{t("search")}</Link>
              </td>
            </tr>
          )}
          {c.article?.title && (
            <tr>
              <td className="muted">{t("article")}</td>
              <td className="cell-wrap">{t("articleRead", { title: c.article.title })}</td>
            </tr>
          )}
          {c.browser && (
            <tr>
              <td className="muted">{t("browser")}</td>
              <td>{c.browser}</td>
            </tr>
          )}
          {c.impact && (
            <tr>
              <td className="muted">{t("impact")}</td>
              <td>
                <span className={c.impact === "blocked" ? "pill bad" : c.impact === "team" ? "pill warn" : "pill"}>{t(`impacts.${c.impact}`)}</span>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </aside>
  );
}

/** T2 · โอนให้พนักงาน Support คนอื่น */
function AssignDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations("ss.t2");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const me = useMe().data;
  // รายชื่อพนักงานอ่านได้เฉพาะ Owner / ผู้ตรวจ · Support คนอื่นใส่รหัสพนักงานไม่ได้ จึงเลือกจากผลงาน 30 วัน (คนที่เคยรับ Ticket)
  const staff = useQuery({
    queryKey: ["ops", "staff"],
    queryFn: () =>
      api.get<{
        items: { id: string; name: string; roles: string[]; status: string }[];
      }>("/staff"),
    enabled: hasAny(me, "owner", "auditor"),
    retry: false,
  });
  const stats = useQuery({
    queryKey: [...key, "stats"],
    queryFn: () => api.get<{ items: { id: string; name: string }[] }>("/tickets/stats"),
  });
  const people = staff.data ? staff.data.items.filter((s) => s.roles.includes("support") && s.status === "active") : (stats.data?.items ?? []);
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const m = useMutation({
    mutationFn: () =>
      api.post(`/tickets/${id}/assign`, {
        staffId: to,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: () => (toast(t("done")), invalidate(cache), onClose()),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), to && m.mutate())}>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">{t("staff")}</legend>
          {people.map((p) => (
            <label key={p.id} className="check">
              <input type="radio" name="t2" checked={to === p.id} onChange={() => setTo(p.id)} />
              <span>{p.name}</span>
            </label>
          ))}
        </fieldset>
        <Textarea label={t("note")} value={note} onChange={(e) => setNote(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!to || m.isPending}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** T5 · ปิดเรื่องพร้อมสาเหตุจริง */
function SolveDialog({ id, number, onClose, initialOutcome = "", onSolved }: { id: string; number: number; onClose: () => void; initialOutcome?: string; onSolved?: () => void }) {
  const t = useTranslations("ss.t5");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  // ส่งและปิดเรื่อง (⇧⌘↵): ใช้คำตอบที่พิมพ์ไว้เป็นผลลัพธ์ถึงลูกค้า
  const [outcome, setOutcome] = useState(initialOutcome);
  const [cause, setCause] = useState("");
  const [csat, setCsat] = useState(true);
  // O35 · X8: ติ๊กแล้วเปิดหน้าศูนย์ช่วยเหลือพร้อม Modal สร้างบทความจากเรื่องนี้หลังปิดเรื่องสำเร็จ
  const th = useTranslations("help.solve");
  const router = useRouter();
  const [kb, setKb] = useState(false);
  const m = useMutation({
    mutationFn: () =>
      api.post(`/tickets/${id}/solve`, {
        outcome: outcome.trim(),
        cause: cause.trim(),
        sendCsat: csat,
      }),
    onSuccess: () => (toast(t("done")), invalidate(cache), onClose(), onSolved?.(), kb && router.push(`/help?fromTicket=${id}`)),
  });
  const ok = outcome.trim().length >= 3 && cause.trim().length >= 3;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title", { n: number })} description={t("desc")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <Textarea label={t("outcome")} value={outcome} onChange={(e) => setOutcome(e.target.value)} />
        <Input label={t("cause")} value={cause} onChange={(e) => setCause(e.target.value)} hint={t("causeHint")} />
        <label className="check">
          <input type="checkbox" checked={csat} onChange={(e) => setCsat(e.target.checked)} />
          <span>{t("csat")}</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={kb} onChange={(e) => setKb(e.target.checked)} />
          <span>{th("kb")}</span>
        </label>
        <p className="muted small">{t("reopen")}</p>
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!ok || m.isPending}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** T1 · สร้าง Ticket สำหรับเรื่องที่มาทางโทรศัพท์ / LINE / อีเมล */
function CreateTicket({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const t = useTranslations("ss.t1");
  const tset = useTranslations("sset");
  const ts = useTranslations("ss.support");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [wsQ, setWsQ] = useState("");
  const [ws, setWs] = useState<{ id: string; name: string } | null>(null);
  const [email, setEmail] = useState("");
  const [channel, setChannel] = useState<"phone" | "line" | "email">("phone");
  const [priority, setPriority] = useState<"rule" | "low" | "normal" | "high" | "urgent">("rule");
  const [category, setCategory] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [assignMe, setAssignMe] = useState(false);
  const [notify, setNotify] = useState(true);
  const search = useDeferredValue(wsQ.trim());
  const found = useQuery({
    queryKey: ["ops", "workspaces", "pick-ticket", search],
    queryFn: () => api.get<{ items: { id: string; name: string; slug: string }[] }>(`/workspaces?q=${encodeURIComponent(search)}&limit=6`),
    enabled: !ws && search.length >= 2,
  });
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && subject.trim().length >= 3 && body.trim().length > 0;
  const m = useMutation({
    mutationFn: () =>
      api.post<{ ticket: { id: string; number: number } }>("/tickets", {
        ...(ws ? { workspaceId: ws.id } : {}),
        requesterEmail: email.trim(),
        channel,
        ...(priority !== "rule" ? { priority } : {}),
        subject: subject.trim(),
        body: body.trim(),
        assignToMe: assignMe,
        notify,
        ...(category ? { category } : {}),
      }),
    onSuccess: (r) => (toast(t("done", { n: r.ticket.number })), invalidate(cache), onClose(), onCreated(r.ticket.id)),
  });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={t("title")} description={t("desc")}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        {ws ? (
          <div className="row">
            <span className="field-label">{t("ws")}:</span> <b>{ws.name}</b>
            <Button size="small" variant="ghost" onClick={() => setWs(null)}>
              ✕
            </Button>
          </div>
        ) : (
          <div className="field">
            <Input label={t("ws")} placeholder={t("wsSearch")} value={wsQ} onChange={(e) => setWsQ(e.target.value)} />
            {found.data?.items.map((w) => (
              <button key={w.id} type="button" className="menu-item" onClick={() => setWs(w)}>
                {w.name} <span className="muted small">{w.slug}</span>
              </button>
            ))}
          </div>
        )}
        <Input label={t("requester")} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <div className="field">
          <span className="field-label">{t("channel")}</span>
          <Seg
            label={t("channel")}
            value={channel}
            onChange={setChannel}
            options={(["phone", "line", "email"] as const).map((c) => ({
              value: c,
              label: ts(`channel.${c}`),
            }))}
          />
        </div>
        <div className="field">
          <span className="field-label">{t("priority")}</span>
          <Seg label={t("priority")} value={priority} onChange={setPriority} options={(["rule", "low", "normal", "high", "urgent"] as const).map((p) => ({ value: p, label: p === "rule" ? t("byRule") : ts(`priority.${p}`) }))} />
        </div>
        <Select label={t("category")} value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">{t("noCategory")}</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {tset(`category.${c}`)}
            </option>
          ))}
        </Select>
        <Input label={t("subject")} value={subject} onChange={(e) => setSubject(e.target.value)} />
        <Textarea label={t("body")} value={body} onChange={(e) => setBody(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={assignMe} onChange={(e) => setAssignMe(e.target.checked)} />
          <span>{t("assignMe")}</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          <span>{t("notify")}</span>
        </label>
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!ok || m.isPending}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

export function Stats() {
  const t = useTranslations("ss.support");
  const q = useQuery({
    queryKey: [...key, "stats"],
    queryFn: () =>
      api.get<{
        items: {
          id: string;
          name: string;
          solved: number;
          firstResponseMinutes: number | null;
          resolutionHours: number | null;
          withinSlaPct: number | null;
          csat: number | null;
        }[];
      }>("/tickets/stats"),
  });
  return (
    <section className="card">
      <h2 className="card-title">{t("stats")}</h2>
      {q.isPending ? (
        <TableSkeleton rows={2} cols={6} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                {(["staff", "solved", "first", "resolve", "sla", "csat"] as const).map((c) => (
                  <th key={c}>{t(`statsCol.${c}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td className="num">{s.solved}</td>
                  <td className="num">{s.firstResponseMinutes == null ? "—" : t("minutes", { n: s.firstResponseMinutes })}</td>
                  <td className="num">{s.resolutionHours == null ? "—" : t("hours", { n: s.resolutionHours })}</td>
                  <td className="num">{s.withinSlaPct == null ? "—" : `${s.withinSlaPct}%`}</td>
                  <td className="num">{s.csat ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
