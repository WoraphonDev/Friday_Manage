"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Avatar, Button, EmptyState, ErrorState, Forbidden, LoadingState, Select, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { formatDateRange, today, type YearFormat } from "@/lib/format";
import { cn } from "@/lib/utils";
import { workloadRange } from "./shared";
import type { Group, ProjectMember, Unit, Workload, WorkloadPerson } from "./types";
import styles from "./members.module.css";

const short = new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", timeZone: "UTC" });
const monthName = new Intl.DateTimeFormat("th-TH", { month: "long", timeZone: "UTC" });
const num = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 1 });
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);

export const workloadParams = (range: { from: string; to: string }, group: Group, unit: Unit) => new URLSearchParams({ from: range.from, to: range.to, group, unit });
/** key เดียวกับมุมมองเริ่มต้น ตาราง Members จึงใช้ข้อมูลสัปดาห์นี้ร่วมกันได้โดยไม่โหลดซ้ำ */
export const workloadKey = (ws: string, projectKey: string, params: URLSearchParams) => ["workload", ws, projectKey, params.toString()];

/** สีแท่งตาม Canvas: < 80% ฟ้าอ่อน · 80–100% น้ำเงิน · เกิน capacity ส้ม */
function tone(pct: number | null, over: boolean) {
  if (over || pct === null) return styles.over;
  return pct >= 80 ? styles.mid : styles.low;
}

export function WorkloadPanel({
  ws,
  projectKey,
  base,
  year,
  members,
  canReassign,
}: {
  ws: string;
  projectKey: string;
  base: string;
  year: YearFormat;
  members: ProjectMember[];
  canReassign: boolean;
}) {
  const t = useTranslations("members-workload.workload");
  const cache = useQueryClient();
  const toast = useToast();
  const [group, setGroup] = useState<Group>("week");
  const [unit, setUnit] = useState<Unit>("md");
  const [offset, setOffset] = useState(0);
  const [position, setPosition] = useState("");
  const [moduleId, setModuleId] = useState("");
  const [selected, setSelected] = useState<{ userId: string; index: number } | null>(null);
  const now = today();
  const range = workloadRange(group, now, offset);

  const params = workloadParams(range, group, unit);
  if (position) params.set("position", position);
  if (moduleId) params.set("moduleId", moduleId);
  const key = workloadKey(ws, projectKey, params);
  const workload = useQuery({
    queryKey: key,
    queryFn: () => api.get<Workload>(`${base}/workload?${params}`),
  });
  // ตัวเลือก Module มาจาก form-options (โหลดไม่ได้ = ซ่อนตัวกรองนี้)
  const options = useQuery({
    queryKey: ["form-options", ws, projectKey],
    queryFn: () => api.get<{ modules: { id: string; name: string }[] }>(`${base}/form-options`),
    retry: false,
  });
  // ตำแหน่งที่มีในทีม · จำค่าจากผลที่ยังไม่กรอง เพื่อไม่ให้ตัวเลือกหายเมื่อกรองแล้ว
  const [positions, setPositions] = useState<string[]>([]);
  const found = workload.data?.people.map((p) => p.position).filter((x): x is string => !!x) ?? [];
  if (!position && found.some((p) => !positions.includes(p))) setPositions([...new Set([...positions, ...found])].sort());

  const pick = (g: Group) => {
    setGroup(g);
    setOffset(0);
    setSelected(null);
  };

  async function reassign(issueKey: string, from: WorkloadPerson, to: ProjectMember) {
    const path = `/w/${encodeURIComponent(ws)}/issues/${encodeURIComponent(issueKey)}`;
    try {
      // ใช้ assigneeIds ล่าสุดของงาน เพื่อไม่ทับ Dev คนอื่นที่ร่วมงานเดียวกัน
      const issue = await api.get<{ assigneeIds: string[]; version: number }>(path);
      const next = issue.assigneeIds.filter((id) => id !== from.person.id);
      if (!next.includes(to.userId)) next.push(to.userId);
      await api.request(`${path}/assignees`, {
        method: "PUT",
        etag: issue.version,
        body: { assigneeIds: next, planChangeReason: t("reassignReason", { from: from.person.displayName, to: to.displayName }) },
      });
      toast({ message: t("reassigned", { key: issueKey, name: to.displayName }) });
    } catch (error) {
      toast({ message: error instanceof ApiError && error.status === 409 ? t("conflict") : error instanceof Error ? error.message : String(error) });
    }
    await cache.invalidateQueries({ queryKey: ["workload", ws, projectKey] });
    await cache.invalidateQueries({ queryKey: ["project-members", ws, projectKey] });
  }

  const toolbar = (
    <div className={styles.bar}>
      <div className={styles.group}>
        <div className={styles.seg} role="group" aria-label={t("granularity")}>
          {(["day", "week", "month"] as const).map((g) => (
            <button key={g} type="button" aria-pressed={group === g} onClick={() => pick(g)}>{t(g)}</button>
          ))}
        </div>
        <span className={styles.range}>
          <Button size="icon" variant="ghost" aria-label={t("prev")} onClick={() => { setOffset((o) => o - 1); setSelected(null); }}><ChevronLeft size={16} /></Button>
          <Button size="small" onClick={() => { setOffset(0); setSelected(null); }}>{formatDateRange(range.from, range.to, year)}</Button>
          <Button size="icon" variant="ghost" aria-label={t("next")} onClick={() => { setOffset((o) => o + 1); setSelected(null); }}><ChevronRight size={16} /></Button>
        </span>
      </div>
      <div className={styles.group}>
        <Select size="small" prefix={t("metric")} aria-label={t("metricLabel")} value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
          {(["md", "hour", "count"] as const).map((u) => <option key={u} value={u}>{t(`unit_${u}`)}</option>)}
        </Select>
        <Select size="small" prefix={t("position")} aria-label={t("position")} value={position} onChange={(e) => setPosition(e.target.value)}>
          <option value="">{t("allPositions")}</option>
          {positions.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        {!!options.data?.modules.length && (
          <Select size="small" prefix={t("module")} aria-label={t("module")} value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
            <option value="">{t("allModules")}</option>
            {options.data.modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        )}
      </div>
    </div>
  );

  if (workload.isPending) return <>{toolbar}<LoadingState /></>;
  if (workload.error)
    return <>{toolbar}{workload.error instanceof ApiError && workload.error.status === 403 ? <Forbidden /> : <ErrorState error={workload.error} retry={() => workload.refetch()} />}</>;

  const data = workload.data;
  const n = data.buckets.length;
  const grid = { gridTemplateColumns: `repeat(${n}, minmax(36px, 1fr))` };
  const currentIndex = data.buckets.findIndex((b) => b.start <= now && now <= b.end);
  const label = (b: { start: string }) => (data.group === "month" ? monthName.format(asDate(b.start)) : short.format(asDate(b.start)));
  const fmt = (v: number) => num.format(v);
  const maxOf = (vals: (number | null)[]) => Math.max(1, ...vals.map((v) => v ?? 0)) * 1.1;
  const personMax = maxOf(data.people.flatMap((p) => p.cells.flatMap((c) => [c.value, c.capacity])));
  const teamMax = maxOf(data.team.flatMap((c) => [c.value, c.capacity]));
  const sel = selected && data.people.find((p) => p.person.id === selected.userId);
  const selCell = sel && sel.cells[selected.index];
  const tw = data.thisWeek;
  const unitLabel = t(`chartUnit_${data.unit}_${data.group}`);

  return (
    <>
      {toolbar}
      <div className={styles.kpis}>
        <div className={styles.kp}>
          <span className={styles.muted}>{t("capacityTitle")}</span>
          <span className={styles.v}>{t("capacityValue", { value: fmt(tw.capacityMd) })}</span>
          <span className={styles.muted}>{t("capacityHint", { people: tw.people, range: formatDateRange(tw.from, tw.to, year) })}</span>
        </div>
        <div className={styles.kp}>
          <span className={styles.muted}>{t("assignedTitle")}</span>
          <span className={cn(styles.v, tw.assignedMd > tw.capacityMd && styles.up)}>{t("assignedValue", { value: fmt(tw.assignedMd) })}</span>
          <span className={styles.muted}>{tw.utilizationPct === null ? t("utilizationUnknown") : t("utilization", { pct: tw.utilizationPct })}</span>
        </div>
        <div className={styles.kp}>
          <span className={styles.muted}>{t("overloadedTitle")}</span>
          <span className={cn(styles.v, tw.overloaded.length > 0 && styles.up)}>{t("overloadedValue", { count: tw.overloaded.length })}</span>
          <span className={styles.muted}>
            {tw.overloaded.length ? tw.overloaded.map((o) => `${o.person.displayName} ${o.utilizationPct ?? "∞"}%`).join(" · ") : t("overloadedNone")}
          </span>
        </div>
        <div className={styles.kp}>
          <span className={styles.muted}>{t("withoutBaTitle")}</span>
          <span className={styles.v}>{data.withoutBa}</span>
          <Link href={`/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/table`}>{t("withoutBaLink")}</Link>
        </div>
        <div className={styles.kp}>
          <span className={styles.muted}>{t("unscheduledTitle")}</span>
          <span className={styles.v}>{data.unscheduled.count}</span>
          <span className={styles.muted}>{t("unscheduledHint", { noDates: data.unscheduled.noDates, noEstimate: data.unscheduled.noEstimate })}</span>
        </div>
      </div>

      <div className={styles.cols}>
        <section className={cn(styles.card, styles.chart)} aria-labelledby="workload-title">
          <div className={styles.chead}>
            <h2 id="workload-title">{t("chartTitle")} <span className={styles.muted}>· {unitLabel}</span></h2>
            <div className={cn(styles.legend, styles.muted)}>
              <span><i className={styles.low} />{t("legendLow")}</span>
              <span><i className={styles.mid} />{t("legendMid")}</span>
              <span><i className={styles.over} />{t("legendOver")}</span>
              {data.unit !== "count" && <span><i className={styles.cap} />{t("legendCap")}</span>}
            </div>
          </div>
          {!data.people.length ? (
            <EmptyState title={t("empty")} description={t("emptyHint")} />
          ) : (
            <div className={styles.scroll}>
              <div className={cn(styles.wl, styles.wlHead)}>
                <span className={styles.muted}>{t("member")}</span>
                <div className={styles.labels} style={grid}>
                  {data.buckets.map((b, i) => <span key={b.start} data-current={i === currentIndex}>{label(b)}</span>)}
                </div>
              </div>
              {data.people.map((p) => (
                <div className={styles.wl} key={p.person.id}>
                  <div className={styles.who}>
                    <Avatar person={p.person} />
                    <div>
                      <div className={styles.name}>{p.person.displayName}</div>
                      <div className={cn(styles.muted, styles.small)}>{p.position ?? "—"}</div>
                      <div className={cn(styles.small, (p.total.utilizationPct ?? 101) > 100 && p.total.value > 0 ? styles.up : styles.muted)}>
                        {p.total.utilizationPct === null ? t("averageUnknown") : t("average", { pct: p.total.utilizationPct })}
                      </div>
                    </div>
                  </div>
                  <div className={styles.bars} style={grid}>
                    {p.cells.map((c, i) => {
                      const on = selected?.userId === p.person.id && selected.index === i;
                      const period = formatDateRange(data.buckets[i].start, data.buckets[i].end, year);
                      return (
                        <div key={data.buckets[i].start}>
                          <span className={cn(styles.val, c.over && styles.overText)}>{c.value ? fmt(c.value) : ""}</span>
                          <button
                            type="button"
                            className={cn(styles.wb, data.unit === "count" ? styles.low : tone(c.utilizationPct, c.over))}
                            style={{ height: `${Math.round((Math.min(c.value, personMax) / personMax) * 90)}px` }}
                            aria-pressed={on}
                            aria-label={c.capacity === null ? t("barLabelCount", { name: p.person.displayName, period, value: fmt(c.value) }) : t("barLabel", { name: p.person.displayName, period, value: fmt(c.value), capacity: fmt(c.capacity) })}
                            onClick={() => setSelected(on ? null : { userId: p.person.id, index: i })}
                          />
                          {c.capacity !== null && <span className={styles.capLine} style={{ bottom: `${Math.round((c.capacity / personMax) * 90)}px` }} />}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              <div className={cn(styles.wl, styles.team)}>
                <div className={styles.who}>
                  <div>
                    <h3>{t("teamTitle")}</h3>
                    <div className={cn(styles.muted, styles.small)}>{t("teamHint")}</div>
                  </div>
                </div>
                <div className={styles.bars} style={grid} aria-label={t("teamRow")} role="list">
                  {data.team.map((c, i) => (
                    <div key={data.buckets[i].start} role="listitem">
                      <span className={styles.val}>{c.capacity === null ? fmt(c.value) : `${fmt(c.value)}/${fmt(c.capacity)}`}</span>
                      <span className={styles.teamBar} style={{ height: `${Math.round((Math.min(c.value, teamMax) / teamMax) * 90)}px` }} />
                      {c.capacity !== null && <span className={styles.capLine} style={{ bottom: `${Math.round((c.capacity / teamMax) * 90)}px` }} />}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>

        <aside className={cn(styles.card, styles.detail)} aria-label={t("detailLabel")}>
          {sel && selCell ? (
            <>
              <div className={styles.chead}>
                <div className={styles.detailHead}>
                  <Avatar person={sel.person} />
                  <div>
                    <h2>{sel.person.displayName} · {formatDateRange(data.buckets[selected!.index].start, data.buckets[selected!.index].end, year)}</h2>
                    <div className={cn(styles.small, selCell.over && styles.up)}>
                      {selCell.capacity === null
                        ? t("detailValueCount", { value: fmt(selCell.value) })
                        : t("detailValue", { value: fmt(selCell.value), capacity: `${fmt(selCell.capacity)} ${data.unit === "md" ? "MD" : t("unit_hour")}`, pct: selCell.utilizationPct ?? "∞" })}
                      {selCell.leaveDays > 0 && ` · ${t("leave", { days: selCell.leaveDays })}`}
                    </div>
                  </div>
                </div>
              </div>
              <div className={styles.tasks}>
                {!selCell.issues.length && <p className={cn(styles.note, styles.muted)}>{t("detailEmpty")}</p>}
                {selCell.issues.map((k) => (
                  <div className={styles.task} key={k.key}>
                    <div>
                      <Link href={`/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/members?issue=${encodeURIComponent(k.key)}`}>{k.title}</Link>
                      <div className={cn(styles.muted, styles.small)}>{k.key}{data.unit !== "count" && ` · ${fmt(k.value)} ${data.unit === "md" ? "MD" : t("unit_hour")}`}</div>
                    </div>
                    {canReassign && (
                      <select
                        aria-label={t("reassign", { title: k.title })}
                        value={sel.person.id}
                        onChange={(e) => {
                          const to = members.find((m) => m.userId === e.target.value);
                          if (to) void reassign(k.key, sel, to);
                        }}
                        className="input"
                      >
                        <option value={sel.person.id}>{sel.person.displayName}</option>
                        {members.filter((m) => m.userId !== sel.person.id && m.active && m.role !== "viewer").map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
                      </select>
                    )}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className={cn(styles.note, styles.muted)}>{t("detailPick")}</p>
          )}
          <p className={cn(styles.note, styles.muted)}>{t("method")}</p>
        </aside>
      </div>
    </>
  );
}
