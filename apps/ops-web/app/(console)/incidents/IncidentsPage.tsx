"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { hasAny } from "@/components/access";
import { ConfirmDialog, useApprovalFlow } from "@/components/dialogs";
import { Chip, Drawer, Empty, ErrorBlock, Notice, PageHead, Seg, TableSkeleton } from "@/components/kit";
import { Button, errorToast, InlineError, Input, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useFmt } from "../workspaces/_parts/format";

const SERVICES = ["web", "api", "import_export", "notifications_email", "notifications_line", "realtime", "files", "billing"] as const;
const STATES = ["investigating", "identified", "monitoring", "resolved"] as const;
interface Incident {
  id: string;
  title: string;
  impact: "minor" | "partial" | "major";
  status: (typeof STATES)[number];
  services: string[];
  internal: boolean;
  startedAt: string;
  resolvedAt: string | null;
  updates: {
    id: string;
    status: string;
    message: string;
    createdAt: string;
    notifySubscribers: boolean;
    showBanner: boolean;
  }[];
}
interface Maint {
  id: string;
  scope: "read_only" | "full" | "import_export";
  message: string;
  startsAt: string;
  endsAt: string;
  status: "scheduled" | "active" | "done" | "cancelled";
}
const invalidate = (cache: ReturnType<typeof useQueryClient>) => void cache.invalidateQueries({ queryKey: ["ops"] });

/** หน้า 12 · เหตุขัดข้อง ปิดปรับปรุง และงานที่ล้ม (Operations.dc.html) */
export function IncidentsPage() {
  const t = useTranslations("ss.ops");
  const params = useSearchParams();
  const me = useMe().data;
  const [creating, setCreating] = useState(params?.get("new") === "1");
  const q = useQuery({
    queryKey: ["ops", "incidents"],
    queryFn: () => api.get<{ items: Incident[]; subscribers: number }>("/incidents"),
  });
  const canIncident = hasAny(me, "engineer", "support");
  const engineer = hasAny(me, "engineer", "owner");
  const open = q.data?.items.filter((i) => i.status !== "resolved") ?? [];
  return (
    <>
      <PageHead
        title={t("title")}
        desc={`${t("desc")}${q.data ? ` · ${t("subscribers", { n: q.data.subscribers })}` : ""}`}
        actions={
          canIncident && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={16} /> {t("new")}
            </Button>
          )
        }
      />
      {q.isPending ? (
        <TableSkeleton rows={3} cols={3} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        <div className="grid-2">
          <section className="stack">
            {!open.length ? (
              <section className="card">
                <Empty ok title={t("noOpen")} />
              </section>
            ) : (
              open.map((i) => <IncidentCard key={i.id} incident={i} subscribers={q.data.subscribers} canUpdate={canIncident} />)
            )}
          </section>
          <PublicPreview items={q.data.items} />
        </div>
      )}
      {engineer && <Maintenance canRequest={hasAny(me, "engineer")} />}
      {hasAny(me, "engineer") && <FailedJobs />}
      {creating && <NewIncident subscribers={q.data?.subscribers ?? 0} onClose={() => setCreating(false)} />}
    </>
  );
}

function IncidentCard({ incident: i, subscribers, canUpdate }: { incident: Incident; subscribers: number; canUpdate: boolean }) {
  const t = useTranslations("ss.ops");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const [status, setStatus] = useState<(typeof STATES)[number]>(i.status === "investigating" ? "identified" : i.status === "identified" ? "monitoring" : "resolved");
  const [message, setMessage] = useState("");
  const [notify, setNotify] = useState(!i.internal);
  const [banner, setBanner] = useState(false);
  const m = useMutation({
    mutationFn: () =>
      api.post<{ notified: number }>(`/incidents/${i.id}/updates`, {
        status,
        message: message.trim(),
        notifySubscribers: notify,
        showBanner: banner,
      }),
    onSuccess: (r) => (setMessage(""), toast(t("published", { n: r.notified })), invalidate(cache)),
  });
  return (
    <article className="card" aria-label={i.title}>
      <div className="card-head">
        <span className={i.impact === "major" ? "pill bad" : "pill warn"}>{t(`state.${i.status}`)}</span>
        <h2 className="card-title">{i.title}</h2>
        {i.internal && <span className="pill">{t("internal")}</span>}
      </div>
      <p className="muted small">
        {t("openedAt", {
          time: fmt.dateTime(i.startedAt),
          impact: t(`impact.${i.impact}`),
          services: i.services.map((s) => (t.has(`services.${s}` as "services.web") ? t(`services.${s}` as "services.web") : s)).join(", "),
        })}
      </p>
      {canUpdate && (
        <form className="stack" onSubmit={(e) => (e.preventDefault(), message.trim().length >= 3 && m.mutate())}>
          <Seg label={t("update")} value={status} onChange={setStatus} options={STATES.map((s) => ({ value: s, label: t(`state.${s}`) }))} />
          <Textarea label={t("message")} value={message} onChange={(e) => setMessage(e.target.value)} />
          {!i.internal && (
            <>
              <label className="check">
                <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
                <span>{t("notify", { n: subscribers })}</span>
              </label>
              <label className="check">
                <input type="checkbox" checked={banner} onChange={(e) => setBanner(e.target.checked)} />
                <span>{t("banner")}</span>
              </label>
            </>
          )}
          <InlineError error={m.error} />
          <div>
            <Button type="submit" variant="primary" disabled={message.trim().length < 3 || m.isPending}>
              {t("publish")}
            </Button>
          </div>
        </form>
      )}
      <details>
        <summary className="small">{t("history")}</summary>
        {i.updates.map((u) => (
          <div key={u.id} className="small">
            <span className="muted">{fmt.dateTime(u.createdAt)}</span> · {t(`state.${u.status}` as "state.resolved")} · {u.message}
          </div>
        ))}
      </details>
    </article>
  );
}

/** ตัวอย่างหน้าสถานะสาธารณะ: เฉพาะเหตุที่ไม่ใช่ภายใน · ชื่อบริการแบบที่ลูกค้าเข้าใจ */
function PublicPreview({ items }: { items: Incident[] }) {
  const t = useTranslations("ss.ops");
  const fmt = useFmt();
  const visible = items.filter((i) => !i.internal && (!i.resolvedAt || Date.now() - Date.parse(i.resolvedAt) < 7 * 86_400_000));
  const open = visible.filter((i) => i.status !== "resolved");
  const tone = open.some((i) => i.impact !== "minor") ? "bad" : open.length ? "warn" : "ok";
  return (
    <section className="card" aria-label={t("preview")}>
      <div className="card-head">
        <h2 className="card-title">{t("preview")}</h2>
      </div>
      <Notice tone={tone} title={tone === "ok" ? t("allOk") : tone === "bad" ? t("outage") : t("degraded")} />
      {visible.map((i) => (
        <div key={i.id} className="small">
          <b>{i.title}</b> · {t(`state.${i.status}`)}
          <div className="muted">{i.updates[0] ? `${fmt.dateTime(i.updates[0].createdAt)} · ${i.updates[0].message}` : ""}</div>
        </div>
      ))}
      <p className="muted small">{t("previewNote")}</p>
    </section>
  );
}

/** Y3 · เปิดเหตุขัดข้องใหม่ */
function NewIncident({ subscribers, onClose }: { subscribers: number; onClose: () => void }) {
  const t = useTranslations("ss.y3");
  const to = useTranslations("ss.ops");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [title, setTitle] = useState("");
  const [impact, setImpact] = useState<"minor" | "partial" | "major">("minor");
  const [services, setServices] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [internal, setInternal] = useState(false);
  const [notify, setNotify] = useState(true);
  const [banner, setBanner] = useState(false);
  const ok = title.trim().length >= 3 && services.length > 0 && message.trim().length >= 3;
  const m = useMutation({
    mutationFn: () =>
      api.post<{ notified: number }>("/incidents", {
        title: title.trim(),
        impact,
        services,
        message: message.trim(),
        internal,
        notifySubscribers: notify,
        showBanner: banner,
      }),
    onSuccess: (r) => (toast(t("done", { n: r.notified })), invalidate(cache), onClose()),
  });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={t("title")} description={t("desc")}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <Input label={t("subject")} value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="field">
          <span className="field-label">{t("impact")}</span>
          <Seg
            label={t("impact")}
            value={impact}
            onChange={setImpact}
            options={(["minor", "partial", "major"] as const).map((v) => ({
              value: v,
              label: to(`impact.${v}`),
            }))}
          />
        </div>
        <div className="field">
          <span className="field-label">{t("services")}</span>
          <div className="row" role="group" aria-label={t("services")}>
            {SERVICES.map((s) => (
              <Chip key={s} pressed={services.includes(s)} onClick={() => setServices(services.includes(s) ? services.filter((x) => x !== s) : [...services, s])}>
                {to(`services.${s}`)}
              </Chip>
            ))}
          </div>
        </div>
        <Textarea label={t("message")} value={message} onChange={(e) => setMessage(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
          <span>{t("internal")}</span>
        </label>
        {!internal && (
          <>
            <label className="check">
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
              <span>{to("notify", { n: subscribers })}</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={banner} onChange={(e) => setBanner(e.target.checked)} />
              <span>{to("banner")}</span>
            </label>
          </>
        )}
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

/** Y5 · ปิดปรับปรุง: ต้องอนุมัติทุกครั้ง (202 → G7 / G12) · ปลด / ยกเลิกได้ทันที */
function Maintenance({ canRequest }: { canRequest: boolean }) {
  const t = useTranslations("ss.ops");
  const ty = useTranslations("ss.y5");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const { handle } = useApprovalFlow();
  const q = useQuery({
    queryKey: ["ops", "maintenance"],
    queryFn: () => api.get<{ items: Maint[]; active: Maint | null }>("/maintenance"),
  });
  const [scope, setScope] = useState<Maint["scope"]>("read_only");
  const [when, setWhen] = useState<"now" | "later">("later");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [plan, setPlan] = useState<"3d_and_1h" | "1d" | "none">("3d_and_1h");
  const [message, setMessage] = useState("");
  const [reason, setReason] = useState("");
  const [ending, setEnding] = useState<Maint | null>(null);
  const [requesting, setRequesting] = useState(false);
  const iso = (local: string) => new Date(local).toISOString();
  const ok = !!end && (when === "now" || !!start) && message.trim().length >= 3 && reason.trim().length >= 3;
  const req = useMutation({
    mutationFn: () =>
      api
        .post("/maintenance", {
          scope,
          message: message.trim(),
          ...(when === "later" ? { startsAt: iso(start) } : {}),
          endsAt: iso(end),
          notifyPlan: plan,
          reason: reason.trim(),
        })
        .then(handle),
    onSuccess: () => (setMessage(""), setReason(""), setRequesting(false), invalidate(cache)),
  });
  const upcoming = (q.data?.items ?? []).filter((m) => m.status === "scheduled" || m.status === "active");
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{t("maintenance")}</h2>
        <span className="spacer" />
        {canRequest && (
          <Button size="small" onClick={() => setRequesting(true)}>
            {ty("open")}
          </Button>
        )}
      </div>
      {q.isPending ? (
        <TableSkeleton rows={1} cols={3} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !upcoming.length ? (
        <p className="muted small">{t("noMaint")}</p>
      ) : (
        upcoming.map((m) => (
          <div key={m.id} className={m.status === "active" ? "notice notice-bad" : "notice notice-warn"}>
            <div className="notice-body">
              <b>
                {m.status === "active" ? t("active") : t("scheduled")} · {ty(`scopes.${m.scope}`)}
              </b>
              <span className="small">
                {fmt.dateTime(m.startsAt)} – {fmt.dateTime(m.endsAt)} · {m.message}
              </span>
            </div>
            <Button size="small" onClick={() => setEnding(m)}>
              {m.status === "active" ? t("end") : t("cancel")}
            </Button>
          </div>
        ))
      )}
      {requesting && (
        <Drawer open onOpenChange={(o) => !o && setRequesting(false)} title={ty("title")} description={ty("note")}>
          <form className="stack" onSubmit={(e) => (e.preventDefault(), ok && req.mutate())}>
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="field-label">{ty("scope")}</legend>
              {(["read_only", "full", "import_export"] as const).map((v) => (
                <label key={v} className="check">
                  <input type="radio" name="y5-scope" checked={scope === v} onChange={() => setScope(v)} />
                  <span>{ty(`scopes.${v}`)}</span>
                </label>
              ))}
            </fieldset>
            <div className="field">
              <span className="field-label">{ty("when")}</span>
              <Seg
                label={ty("when")}
                value={when}
                onChange={setWhen}
                options={[
                  { value: "later", label: ty("later") },
                  { value: "now", label: ty("now") },
                ]}
              />
            </div>
            <div className="grid-2">
              {when === "later" && <Input label={ty("start")} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />}
              <Input label={ty("end")} type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="y5-notify">{ty("notify")}</label>
              <select id="y5-notify" className="input" value={plan} onChange={(e) => setPlan(e.target.value as typeof plan)}>
                {(["3d_and_1h", "1d", "none"] as const).map((v) => (
                  <option key={v} value={v}>
                    {ty(`notifyPlans.${v}`)}
                  </option>
                ))}
              </select>
            </div>
            <Textarea label={ty("message")} value={message} onChange={(e) => setMessage(e.target.value)} />
            <Input label={ty("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
            <InlineError error={req.error} />
            <div className="dialog-actions">
              <Button onClick={() => setRequesting(false)}>{tc("cancel")}</Button>
              <Button type="submit" variant="primary" disabled={!ok || req.isPending}>
                {ty("submit")}
              </Button>
            </div>
          </form>
        </Drawer>
      )}
      {ending && (
        <ConfirmDialog
          open
          minReason={0}
          onOpenChange={() => setEnding(null)}
          title={`${ending.status === "active" ? t("end") : t("cancel")} · ${ty(`scopes.${ending.scope}`)}`}
          onConfirm={async () => {
            await api.post(`/maintenance/${ending.id}/end`, {});
            toast(t("endDone"));
            invalidate(cache);
          }}
        />
      )}
    </section>
  );
}

interface FailedJob {
  id: string;
  name: string;
  reason: string;
  attempts: number;
  failedAt: string | null;
  workspaceId: string | null;
}
/** งานเบื้องหลังที่ล้ม: ลองใหม่ (ทีละงาน / ที่เลือก) · ทิ้งพร้อมเหตุผล */
function FailedJobs() {
  const t = useTranslations("ss.ops");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const q = useQuery({
    queryKey: ["ops", "jobs", "failed"],
    queryFn: () => api.get<{ configured: boolean; items: FailedJob[] }>("/jobs/failed"),
  });
  const [picked, setPicked] = useState<string[]>([]);
  const [discarding, setDiscarding] = useState<FailedJob | null>(null);
  const retry = useMutation({
    mutationFn: (ids: string[]) => api.post<{ items: { retried: boolean }[] }>("/jobs/retry", { ids }),
    onSuccess: (r) => (setPicked([]), toast(t("retried", { n: r.items.filter((x) => x.retried).length })), invalidate(cache)),
    onError: (e) => toast(errorToast(e)),
  });
  return (
    <section className="card" id="jobs">
      <div className="card-head">
        <h2 className="card-title">{t("jobs")}</h2>
        {q.data?.configured && <span className="pill bad">{q.data.items.length}</span>}
        <span className="spacer" />
        {picked.length > 0 && (
          <Button size="small" disabled={retry.isPending} onClick={() => retry.mutate(picked)}>
            {t("retrySelected")}
          </Button>
        )}
      </div>
      <p className="muted small">{t("jobsNote")}</p>
      {q.isPending ? (
        <TableSkeleton rows={2} cols={6} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !q.data.configured ? (
        <Notice tone="warn">{t("jobsOff")}</Notice>
      ) : !q.data.items.length ? (
        <Empty ok title={t("noJobs")} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th />
                <th>{t("job")}</th>
                <th>{t("ws")}</th>
                <th>{t("reason")}</th>
                <th className="num">{t("attempts")}</th>
                <th>{t("failedAt")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((j) => (
                <tr key={j.id}>
                  <td>
                    <input type="checkbox" aria-label={`${t("job")} ${j.name} ${j.id}`} checked={picked.includes(j.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, j.id] : picked.filter((x) => x !== j.id))} />
                  </td>
                  <td className="mono small">
                    {j.name} <span className="muted">#{j.id}</span>
                  </td>
                  <td className="mono small">{j.workspaceId?.slice(0, 8) ?? "—"}</td>
                  <td className="small">{j.reason}</td>
                  <td className="num">{j.attempts}</td>
                  <td className="small">{fmt.ago(j.failedAt)}</td>
                  <td>
                    <span className="row" style={{ flexWrap: "nowrap" }}>
                      <Button size="small" disabled={retry.isPending} onClick={() => retry.mutate([j.id])}>
                        {t("retry")}
                      </Button>
                      <Button size="small" variant="ghost" onClick={() => setDiscarding(j)}>
                        {t("discard")}
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {discarding && (
        <ConfirmDialog
          open
          danger
          onOpenChange={() => setDiscarding(null)}
          title={t("discardTitle", { name: discarding.name })}
          description={discarding.reason}
          onConfirm={async ({ reason }) => {
            await api.post(`/jobs/${discarding.id}/discard`, { reason });
            toast(t("discarded"));
            invalidate(cache);
          }}
        />
      )}
    </section>
  );
}
