"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useApprovalFlow, useReauth } from "@/components/dialogs";
import { Drawer, ErrorBlock, Modal, TableSkeleton } from "@/components/kit";
import { Button, InlineError, Input, Select, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { planLabel, useFmt } from "../../workspaces/_parts/format";
import styles from "../ratelimit.module.css";
import { type Point, RL_KEY, type RlDetail } from "./types";

const MINUTES = 24 * 60;
const H = 160;

/**
 * กราฟคำขอต่อนาที 24 ชม. (หนึ่งหน่วยแกน x = หนึ่งนาที) · แท่งคำขอ + ส่วนที่ถูกปฏิเสธ + เส้นเพดาน (เปลี่ยนตามเวลาเมื่อมีการปรับ)
 * นาทีที่ไม่มีข้อมูล = ไม่มีการเรียก
 */
export function UsageChart({ series, limit }: { series: Point[]; limit: number | null }) {
  const t = useTranslations("rl.drawer");
  const fmt = useFmt();
  const start = Date.now() - MINUTES * 60_000;
  const xOf = (iso: string) => Math.max(0, Math.min(MINUTES - 1, Math.floor((Date.parse(iso) - start) / 60_000)));
  const peak = Math.max(0, ...series.map((p) => p.calls));
  const top = Math.max(1, peak, ...series.map((p) => p.limit ?? 0)) * 1.1;
  const y = (v: number) => H - (v / top) * H;
  // เส้นเพดานแบบขั้นบันได · ช่วงไม่มีข้อมูลใช้ค่าล่าสุดที่รู้
  const steps = series.filter((p) => p.limit != null);
  const line = steps.length
    ? [`0,${y(steps[0].limit!)}`, ...steps.flatMap((p, i) => (i && p.limit !== steps[i - 1].limit ? [`${xOf(p.minute)},${y(steps[i - 1].limit!)}`, `${xOf(p.minute)},${y(p.limit!)}`] : [])), `${MINUTES},${y(steps.at(-1)!.limit!)}`].join(" ")
    : limit
      ? `0,${y(limit)} ${MINUTES},${y(limit)}`
      : null;
  const rejected = series.reduce((n, p) => n + p.rejected, 0);
  if (!series.length) return <p className="muted small">{t("noData")}</p>;
  return (
    <figure className="stack-tight" style={{ margin: 0 }}>
      <svg className={styles.chart} viewBox={`0 0 ${MINUTES} ${H}`} preserveAspectRatio="none" role="img" aria-label={t("chartLabel", { peak: fmt.num(peak), limit: limit == null ? "—" : fmt.num(limit), rejected: fmt.num(rejected) })}>
        {series.map((p) => (
          <g key={p.minute}>
            <rect className={styles.calls} x={xOf(p.minute)} y={y(p.calls)} width={1} height={H - y(p.calls)} />
            {p.rejected > 0 && <rect className={styles.rejected} x={xOf(p.minute)} y={y(p.rejected)} width={1} height={H - y(p.rejected)} />}
          </g>
        ))}
        {line && <polyline className={styles.limitLine} points={line} />}
      </svg>
      <div className={styles.axis}>
        <span>{t("ago24")}</span>
        <span>{t("now")}</span>
      </div>
      <div className={styles.legend}>
        <span>
          <i className={`${styles.swatch} ${styles.swCalls}`} />
          {t("legendCalls")}
        </span>
        <span>
          <i className={`${styles.swatch} ${styles.swRejected}`} />
          {t("legendRejected")}
        </span>
        {limit != null && (
          <span>
            <i className={`${styles.swatch} ${styles.swLimit}`} />
            {t("limitLine", { n: fmt.num(limit) })}
          </span>
        )}
      </div>
    </figure>
  );
}

/** แผงขวา (storyboard ขั้น 2): กราฟ 24 ชม. · แยกตาม token / endpoint · ระงับ token · แจ้ง Owner · ปรับเพดานชั่วคราว */
export function RlDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations("rl");
  const td = useTranslations("rl.drawer");
  const fmt = useFmt();
  const q = useQuery({ queryKey: [...RL_KEY, "ws", id], queryFn: () => api.get<RlDetail>(`/ratelimit/workspaces/${id}`) });
  const [dialog, setDialog] = useState<null | "notify" | "limit" | { tokenId: string; token: string }>(null);
  const d = q.data;
  const st = d?.stats;
  const limit = st?.limit ?? null;
  const desc = d
    ? [
        d.override ? td("baseOverride", { limit: d.override.value == null ? t("unlimited") : fmt.num(d.override.value), until: fmt.date(d.override.expiresAt) }) : td("basePlan", { limit: limit == null ? t("unlimited") : fmt.num(limit) }),
        st?.curStreak ? td("streakNow", { n: st.curStreak }) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={d ? `${d.name} · ${planLabel(st?.plan)}` : t("title")} description={desc} wide>
      {q.isPending ? (
        <TableSkeleton rows={4} cols={3} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        d && (
          <div className="stack">
            <section className="stack-tight" aria-label={td("chart")}>
              <h3 className="card-title">{td("chart")}</h3>
              <UsageChart series={d.series} limit={limit} />
            </section>
            <section className="stack-tight" aria-label={td("byToken")}>
              <h3 className="card-title">{td("byToken")}</h3>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th scope="col">token</th>
                      <th scope="col">{t("col.endpoint")}</th>
                      <th scope="col" className="num">
                        {t("col.perMin")}
                      </th>
                      <th scope="col" className="num">
                        {t("col.rejected")}
                      </th>
                      <th scope="col">
                        <span className="sr-only">{td("blockToken")}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.breakdown.map((b, i) => {
                      const first = d.breakdown.findIndex((x) => x.tokenId === b.tokenId) === i;
                      return (
                        <tr key={`${b.tokenId}-${b.route}`}>
                          <td className="mono">
                            {b.token ?? "—"}
                            {b.revoked && <div className="cell-sub">{td("revoked")}</div>}
                          </td>
                          <td className="mono small">{b.route}</td>
                          <td className="num">{fmt.num(b.peak)}</td>
                          <td className="num">{fmt.num(b.rejected)}</td>
                          <td className="num">
                            {first && !b.revoked && (
                              <Button size="small" variant="ghost" onClick={() => setDialog({ tokenId: b.tokenId, token: b.token ?? b.tokenId })}>
                                {td("blockToken")}
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
            {d.override && <p className="muted small">{td("currentOverride", { value: d.override.value == null ? t("unlimited") : fmt.num(d.override.value), until: fmt.date(d.override.expiresAt), reason: d.override.reason })}</p>}
            {d.lastNotifiedAt && <p className="muted small">{td("lastNotified", { at: fmt.dateTime(d.lastNotifiedAt) })}</p>}
            <div className={styles.actions}>
              <Button onClick={() => setDialog("notify")}>{t("notify")}</Button>
              <Button variant="primary" onClick={() => setDialog("limit")}>
                {td("tempLimit")}
              </Button>
            </div>
            <p className="muted small">{t("multiNote")}</p>
          </div>
        )
      )}
      {d && dialog === "notify" && <NotifyDialog id={d.id} name={d.name} onClose={() => setDialog(null)} />}
      {d && dialog === "limit" && <LimitDialog d={d} onClose={() => setDialog(null)} />}
      {d && dialog && typeof dialog === "object" && <BlockTokenDialog workspace={d.name} {...dialog} onClose={() => setDialog(null)} />}
    </Drawer>
  );
}

export function NotifyDialog({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const td = useTranslations("rl.drawer");
  const tc = useTranslations("common.dialog");
  const t = useTranslations("rl");
  const toast = useToast();
  const cache = useQueryClient();
  const [note, setNote] = useState("");
  const m = useMutation({
    mutationFn: () => api.post<{ sent: number; recipients: number }>(`/ratelimit/workspaces/${id}/notify`, note.trim() ? { note: note.trim() } : {}),
    onSuccess: (r) => (toast(td("notified", r)), void cache.invalidateQueries({ queryKey: RL_KEY }), onClose()),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={td("notifyTitle", { name })} description={td("notifyHint")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), !m.isPending && m.mutate())}>
        <Textarea label={td("notifyNote")} value={note} onChange={(e) => setNote(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={m.isPending}>
            {t("notify")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const DAYS = [1, 3, 7, 14, 30] as const;

/** ปรับเพดานชั่วคราว · เกิน 3 เท่าของแพ็กเกจ = ส่งขออนุมัติ (ops-api ตอบ 202 → หน้าต่างคำขออนุมัติเดิม) */
function LimitDialog({ d, onClose }: { d: RlDetail; onClose: () => void }) {
  const td = useTranslations("rl.drawer");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const { handle } = useApprovalFlow();
  const base = d.stats?.base ?? null;
  const [value, setValue] = useState(String(Math.max(1, (d.stats?.limit ?? base ?? 60) * 2)));
  const [days, setDays] = useState<(typeof DAYS)[number]>(7);
  const [reason, setReason] = useState("");
  const n = Math.round(Number(value));
  const max = base ? base * d.headroom : null;
  const ok = n >= 1 && reason.trim().length >= 3;
  const m = useMutation({
    mutationFn: () => run(() => api.post(`/ratelimit/workspaces/${d.id}/limit`, { value: n, days, reason: reason.trim() }), td("tempLimit")).then(handle),
    onSuccess: (r) => {
      if (!(r as { pendingApproval?: unknown }).pendingApproval) toast(td("saved"));
      void cache.invalidateQueries({ queryKey: RL_KEY });
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={td("tempTitle", { name: d.name })} description={td("tempNote")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && !m.isPending && m.mutate())}>
        <Input
          label={td("value")}
          type="number"
          min={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          hint={max ? (n > max ? td("overHeadroom", { x: d.headroom, max: fmt.num(max) }) : td("withinHeadroom", { x: d.headroom, max: fmt.num(max) })) : undefined}
        />
        <Select label={td("days")} value={days} onChange={(e) => setDays(Number(e.target.value) as (typeof DAYS)[number])}>
          {DAYS.map((x) => (
            <option key={x} value={x}>
              {td("daysN", { n: x })}
            </option>
          ))}
        </Select>
        <Textarea label={tc("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!ok || m.isPending}>
            {td("tempLimit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** ระงับ token = เพิ่มในรายชื่อที่ถูกบล็อกของหน้าตรวจจับการใช้ผิด (O50) ซึ่งยกเลิก token ทันที */
function BlockTokenDialog({ tokenId, token, workspace, onClose }: { tokenId: string; token: string; workspace: string; onClose: () => void }) {
  const td = useTranslations("rl.drawer");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => run(() => api.post("/abuse/blocks", { kind: "api_token", value: tokenId, reason: reason.trim() }), td("blockToken")),
    onSuccess: () => (toast(td("blocked")), void cache.invalidateQueries({ queryKey: RL_KEY }), void cache.invalidateQueries({ queryKey: ["ops", "abuse"] }), onClose()),
  });
  const ok = reason.trim().length >= 3 && !m.isPending;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={td("blockTitle", { token })} description={`${workspace} · ${td("blockNote")}`}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <Textarea label={tc("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="danger" disabled={!ok}>
            {td("blockToken")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
