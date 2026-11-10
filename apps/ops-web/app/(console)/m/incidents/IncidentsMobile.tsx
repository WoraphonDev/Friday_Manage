"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { hasAny, rolesOf } from "@/components/access";
import { ErrorBlock, NoAccess, Notice, Seg, Switch, TableSkeleton } from "@/components/kit";
import { Button, InlineError, Pill, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { MobileHead } from "../_parts/MobileFrame";

const STATES = ["investigating", "identified", "monitoring", "resolved"] as const;
type State = (typeof STATES)[number];
const SERVICES = ["web", "api", "import_export", "notifications_email", "notifications_line", "realtime", "files", "billing"] as const;
interface Incident {
  id: string;
  title: string;
  impact: "minor" | "partial" | "major";
  status: State;
  services: string[];
  internal: boolean;
  startedAt: string;
  resolvedAt: string | null;
  updates: { id: string; status: State; message: string; createdAt: string }[];
}
const KEY = ["ops", "incidents"] as const;
const tone = (s: State) => (s === "investigating" ? "bad" : s === "resolved" ? "ok" : "warn");

/** M6.2 · อัปเดตเหตุขัดข้องบนมือถือ: เลือกสถานะ → ข้อความแนะนำเปลี่ยนตาม แก้ต่อได้ → เผยแพร่ (ปุ่มล่างจอ) */
export function IncidentsMobile() {
  const t = useTranslations("mob.incidents");
  const ts = useTranslations("ss.ops");
  const f = useFormatter();
  const me = useMe().data;
  const read = hasAny(me, "engineer", "support", "owner");
  const write = hasAny(me, "engineer", "support");
  const params = useSearchParams();
  const router = useRouter();
  const cache = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<{ items: Incident[]; subscribers: number }>("/incidents"), enabled: read, refetchInterval: 60_000 });
  const open = (q.data?.items ?? []).filter((i) => i.status !== "resolved");
  const cur = open.find((i) => i.id === params?.get("id")) ?? open[0] ?? null;
  const [state, setState] = useState<State>("identified");
  const [message, setMessage] = useState("");
  const [mail, setMail] = useState(true);
  const [published, setPublished] = useState<{ n: number; mail: boolean } | null>(null);
  // เปลี่ยนเหตุ → เริ่มที่สถานะถัดไปพร้อมข้อความแนะนำ
  useEffect(() => {
    if (!cur) return;
    const next = STATES[Math.min(STATES.indexOf(cur.status) + 1, STATES.length - 1)];
    setState(next);
    setMessage(t(`suggest.${next}`));
    setMail(!cur.internal);
    setPublished(null);
  }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (s: State) => (setState(s), setMessage(t(`suggest.${s}`)), setPublished(null));
  const m = useMutation({
    mutationFn: () => api.post<{ notified: number }>(`/incidents/${cur!.id}/updates`, { status: state, message: message.trim(), notifySubscribers: mail && !cur!.internal, showBanner: false }),
    onSuccess: (r) => (setPublished({ n: r.notified, mail: mail && !cur!.internal }), void cache.invalidateQueries({ queryKey: KEY })),
  });
  if (me && !read) return <NoAccess need={["engineer", "support", "owner"]} mine={rolesOf(me)} />;
  const svcName = (s: string) => (ts.has(`services.${s}` as "services.web") ? ts(`services.${s}` as "services.web") : s);
  const affected = new Set(open.filter((i) => !i.internal).flatMap((i) => i.services));
  return (
    <>
      <MobileHead title={t("title")} sub={q.data ? <Pill tone={open.length ? "bad" : "ok"}>{t("open", { n: open.length })}</Pill> : undefined} />
      {q.isPending ? (
        <TableSkeleton rows={4} cols={1} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !cur ? (
        <section className="m-done">
          <span className="m-done-icon" aria-hidden="true">
            ✓
          </span>
          <p>{t("empty")}</p>
          {write && (
            <Link className="button m-btn" href="/incidents">
              {t("openOnDesktop")}
            </Link>
          )}
        </section>
      ) : (
        <>
          <section className="m-card" aria-label={cur.title}>
            <span className="row">
              <Pill tone={tone(cur.status)}>{ts(`state.${cur.status}`)}</Pill>
              <span className="muted small">{t("openedAt", { time: f.dateTime(new Date(cur.startedAt), { timeStyle: "short", dateStyle: "short" }) })}</span>
            </span>
            <h2 className="m-title">{cur.title}</h2>
            <p className="muted small">{t("affects", { services: cur.services.map(svcName).join(", "), impact: t(`impact.${cur.impact}`) })}</p>
            {cur.internal && <Notice tone="info" title={t("internal")} />}
          </section>
          {write ? (
            <section className="m-card">
              <span className="field-label">{t("newState")}</span>
              <Seg label={t("newState")} value={state} onChange={pick} options={STATES.map((s) => ({ value: s, label: ts(`state.${s}`) }))} />
              <Textarea label={t("message")} rows={4} value={message} onChange={(e) => (setMessage(e.target.value), setPublished(null))} />
              {!cur.internal && (
                <label className="row m-row">
                  <Switch checked={mail} label={t("mail", { n: q.data.subscribers })} onChange={setMail} />
                  <span>{t("mail", { n: q.data.subscribers })}</span>
                </label>
              )}
            </section>
          ) : (
            <Notice tone="info" title={t("viewOnly")} />
          )}
          <section className="m-card">
            <h2 className="card-title">{t("log")}</h2>
            <ol className="m-rows">
              {[...cur.updates].reverse().map((u) => (
                <li key={u.id}>
                  <span className="muted small num">{f.dateTime(new Date(u.createdAt), { timeStyle: "short" })}</span>
                  <span className="spacer">
                    {ts(`state.${u.status}`)} · {u.message}
                  </span>
                </li>
              ))}
            </ol>
          </section>
          <section className="m-card">
            <h2 className="card-title">{t("services")}</h2>
            <ul className="m-rows">
              {SERVICES.map((s) => (
                <li key={s}>
                  <span>{svcName(s)}</span>
                  <span className="row small">
                    <span className={`person-dot ${affected.has(s) ? "person-dot-busy" : "person-dot-online"}`} aria-hidden="true" />
                    {affected.has(s) ? t("affected") : t("ok")}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          {open.length > 1 && (
            <section className="m-card">
              <h2 className="card-title">{t("others")}</h2>
              <ul className="m-rows">
                {open
                  .filter((i) => i.id !== cur.id)
                  .map((i) => (
                    <li key={i.id}>
                      <button type="button" className="link-button" onClick={() => router.replace(`/m/incidents?id=${i.id}`)}>
                        {i.title}
                      </button>
                      <Pill tone={tone(i.status)}>{ts(`state.${i.status}`)}</Pill>
                    </li>
                  ))}
              </ul>
            </section>
          )}
          {write && (
            <div className="m-actions m-sticky">
              <InlineError error={m.error} />
              <Button variant="primary" className="m-btn m-wide" disabled={m.isPending || !!published || message.trim().length < 3} onClick={() => m.mutate()}>
                {published ? (published.mail ? t("publishedMail", { n: published.n }) : t("published")) : t("publish")}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
