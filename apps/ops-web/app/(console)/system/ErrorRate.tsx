"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { hasAny } from "@/components/access";
import { Modal, Notice } from "@/components/kit";
import { Button, InlineError, Input, Select, useToast, errorToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";

export interface AlertSettings {
  thresholdPct: number;
  windowMin: 5 | 10 | 15 | 30;
  minRequests: number;
  push: boolean;
  email: boolean;
  autoIncident: boolean;
}
export interface ErrorRateNow {
  at: string;
  ratePct: number | null;
  errors: number;
  total: number;
  windowMin: number;
  topRoute: string | null;
  p95Ms: number | null;
  thresholdPct: number;
  minRequests: number;
  over: boolean;
  overMinutes: number | null;
}
export interface SystemAlert {
  id: string;
  startedAt: string;
  details: { ratePct: number; errors: number; total: number; windowMin: number; topRoute: string | null; p95Ms: number | null; peakPct: number; normalSince: string | null };
  lastNotifiedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: { id: string; name: string } | null;
  incidentId: string | null;
}
export interface ErrorHour {
  from: string;
  total: number;
  errors: number;
  ratePct: number | null;
  over: boolean;
}

const WINDOWS = [5, 10, 15, 30] as const;
const pct = (n: number | null) => (n == null ? "—" : `${n}%`);

/** การ์ด KPI "Error rate 5 นาที" (S10) · เกินเกณฑ์ตัวเลขเป็นสีแดง */
export function ErrorRateKpi({ now, settings }: { now: ErrorRateNow | null; settings: AlertSettings }) {
  const t = useTranslations("ss.system");
  const f = useFormatter();
  const window = now?.windowMin ?? settings.windowMin;
  return (
    <section className="card">
      <span className="muted small">{t("errorRate", { n: window })}</span>
      <span className="page-title" style={now?.over ? { color: "var(--danger-text)" } : undefined}>
        {now ? pct(now.ratePct) : "—"}
      </span>
      <span className="muted small">
        {!now
          ? t("notConnected")
          : now.overMinutes != null
            ? t("errSubOver", { pct: now.thresholdPct, n: now.overMinutes })
            : now.total < now.minRequests
              ? t("errSubFew", { pct: now.thresholdPct, min: f.number(now.minRequests) })
              : t("errSub", { pct: now.thresholdPct, total: f.number(now.total) })}
      </span>
    </section>
  );
}

/** ป้ายแดง "Error rate เกินเกณฑ์" + ปุ่มเปิดเหตุขัดข้อง (S10) */
export function ErrorRateNotice({ alert, settings }: { alert: SystemAlert; settings: AlertSettings }) {
  const t = useTranslations("ss.system");
  const f = useFormatter();
  const me = useMe().data;
  const router = useRouter();
  const toast = useToast();
  const cache = useQueryClient();
  const d = alert.details;
  const time = (iso: string) => f.dateTime(new Date(iso), { timeStyle: "short" });
  const open = useMutation({
    mutationFn: () => api.post<{ incidentId: string; created: boolean }>(`/system/alerts/${alert.id}/incident`, {}),
    onSuccess: (r) => (toast(t("incidentOpened")), void cache.invalidateQueries({ queryKey: ["ops"] }), router.push(`/incidents?id=${r.incidentId}`)),
    onError: (e) => toast(errorToast(e)),
  });
  const canOpen = hasAny(me, "engineer", "support");
  return (
    <Notice
      tone={d.normalSince ? "warn" : "bad"}
      title={t("errTitle")}
      action={
        <span className="row">
          {alert.incidentId ? (
            <Button size="small" onClick={() => router.push(`/incidents?id=${alert.incidentId}`)}>
              {t("viewIncident")}
            </Button>
          ) : (
            canOpen && (
              <Button size="small" variant="primary" disabled={open.isPending} onClick={() => open.mutate()}>
                {t("openIncident")}
              </Button>
            )
          )}
        </span>
      }
    >
      {t("errBody", { errors: f.number(d.errors), total: f.number(d.total), n: d.windowMin })}
      {d.topRoute && (
        <>
          {" · "}
          {t("errRoute")} <span className="mono">{d.topRoute}</span>
        </>
      )}
      {" · "}
      {settings.push || settings.email ? (alert.lastNotifiedAt ? t("errNotified", { time: time(alert.lastNotifiedAt) }) : "") : t("errNotifiedOff")}
      {alert.acknowledgedBy && alert.acknowledgedAt && <> · {t("errAcked", { name: alert.acknowledgedBy.name, time: time(alert.acknowledgedAt) })}</>}
      {d.normalSince && <> · {t("errRecovering")}</>}
    </Notice>
  );
}

/** กราฟ Error rate 24 ชม. รายชั่วโมง · แท่งแดง = เกินเกณฑ์ */
export function ErrorRateChart({ hours, settings, onSettings }: { hours: ErrorHour[]; settings: AlertSettings; onSettings: () => void }) {
  const t = useTranslations("ss.system");
  const f = useFormatter();
  // สเกลอย่างน้อย 2 เท่าของเกณฑ์ ให้แท่งปกติไม่สูงเต็มกรอบ
  const max = Math.max(settings.thresholdPct * 2, ...hours.map((h) => h.ratePct ?? 0));
  const time = (iso: string) => f.dateTime(new Date(iso), { timeStyle: "short" });
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{t("errChart")}</h2>
        <Button size="small" onClick={onSettings}>
          {t("alertSettings")}
        </Button>
      </div>
      <div role="img" aria-label={t("errChart")} style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 120 }}>
        {hours.map((h) => (
          <span
            key={h.from}
            data-over={h.over || undefined}
            title={h.total ? t("errChartBar", { time: time(h.from), rate: pct(h.ratePct), errors: f.number(h.errors), total: f.number(h.total) }) : `${time(h.from)} · ${t("errChartEmpty")}`}
            style={{
              flex: 1,
              minHeight: 3,
              height: h.ratePct == null ? 3 : `${Math.max(3, (h.ratePct / max) * 100)}%`,
              borderRadius: "3px 3px 0 0",
              background: h.ratePct == null ? "var(--subtle)" : h.over ? "var(--danger)" : "var(--chart-primary-soft)",
            }}
          />
        ))}
      </div>
      <div className="muted small row" style={{ justifyContent: "space-between" }}>
        <span>{hours[0] ? t("errChartFrom", { time: time(hours[0].from) }) : ""}</span>
        <span>{t("errChartLegend", { pct: settings.thresholdPct })}</span>
        <span>{t("errChartNow")}</span>
      </div>
    </section>
  );
}

/** S11 · ตั้งเกณฑ์แจ้งเตือน Error rate (Owner / วิศวกร) */
export function AlertSettingsDialog({ initial, onClose }: { initial: AlertSettings; onClose: () => void }) {
  const t = useTranslations("ss.system.alerts");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [v, setV] = useState({ ...initial, thresholdPct: String(initial.thresholdPct), minRequests: String(initial.minRequests) });
  const threshold = Number(v.thresholdPct);
  const min = Number(v.minRequests);
  const valid = v.thresholdPct !== "" && threshold >= 0.1 && threshold <= 50 && v.minRequests !== "" && Number.isInteger(min) && min >= 0;
  const m = useMutation({
    mutationFn: () => api.put<{ saved: boolean }>("/system/alert-settings", { ...v, thresholdPct: threshold, minRequests: min }),
    onSuccess: (r) => (toast(r.saved ? t("saved") : t("unchanged")), void cache.invalidateQueries({ queryKey: ["ops", "system"] }), onClose()),
  });
  const check = (key: "push" | "email" | "autoIncident") => (
    <label className="check">
      <input type="checkbox" checked={v[key]} onChange={(e) => setV({ ...v, [key]: e.target.checked })} />
      <span>{t(key)}</span>
    </label>
  );
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title")} description={t("desc")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), valid && m.mutate())}>
        <div className="grid-2">
          <Input label={t("threshold")} type="number" inputMode="decimal" min={0.1} max={50} step={0.1} value={v.thresholdPct} onChange={(e) => setV({ ...v, thresholdPct: e.target.value })} />
          <Select label={t("window")} value={v.windowMin} onChange={(e) => setV({ ...v, windowMin: Number(e.target.value) as AlertSettings["windowMin"] })}>
            {WINDOWS.map((n) => (
              <option key={n} value={n}>
                {t("windowOpt", { n })}
              </option>
            ))}
          </Select>
        </div>
        <Input label={t("minRequests", { n: v.windowMin })} type="number" inputMode="numeric" min={0} step={1} value={v.minRequests} hint={t("minHint")} onChange={(e) => setV({ ...v, minRequests: e.target.value })} />
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">{t("notify")}</legend>
          {check("push")}
          {check("email")}
          {check("autoIncident")}
        </fieldset>
        <Notice tone="info">{t("repeat")}</Notice>
        <p className="muted small">{t("note")}</p>
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!valid || m.isPending}>
            {t("save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
