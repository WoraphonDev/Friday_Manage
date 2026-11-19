"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clock, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { CopyButton, Drawer, ErrorBlock, Modal, Notice, TableSkeleton } from "@/components/kit";
import { useApprovalFlow } from "@/components/dialogs";
import { Button, InlineError, Input, Pill, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useFmt } from "../../workspaces/_parts/format";
import styles from "../quotes.module.css";
import { type Quote, QuoteEditor, QUOTES_KEY } from "./QuoteEditor";

const STEPS = ["contract", "entitlements", "sla", "invoice", "renewal", "lead"] as const;

/** แผงขวา: สถานะ · ส่ง / ส่งลิงก์ใหม่ · ลูกค้าเปิดดูกี่ครั้ง · หลังตอบรับเห็นขั้นที่ระบบทำต่อให้ทีละข้อ (ล้มลองใหม่ได้) */
export function QuoteDrawer({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const t = useTranslations("quotes");
  const td = useTranslations("quotes.drawer");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const { handle } = useApprovalFlow();
  const q = useQuery({ queryKey: [...QUOTES_KEY, "quote", id], queryFn: () => api.get<Quote>(`/quotes/${id}`) });
  const [link, setLink] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [linking, setLinking] = useState(false);
  const refresh = () => void cache.invalidateQueries({ queryKey: QUOTES_KEY });
  const send = useMutation({
    mutationFn: () => api.post<Quote & { link?: string; emailed?: number }>(`/quotes/${id}/send`).then(handle),
    onSuccess: (r) => {
      const res = r as { pendingApproval?: unknown; link?: string; emailed?: number };
      if (res.pendingApproval) toast(td("pending"));
      else {
        setLink(res.link ?? null);
        toast(td("sentTo", { n: res.emailed ?? 0 }));
      }
      refresh();
    },
  });
  const copy = useMutation({ mutationFn: () => api.post<Quote>(`/quotes/${id}/copy`), onSuccess: (r) => (toast(td("copied")), refresh(), onOpen(r.id)) });
  const extend = useMutation({ mutationFn: () => api.post(`/quotes/${id}/extend`, { days: 14 }), onSuccess: () => (toast(t("extended")), refresh()) });
  const retry = useMutation({ mutationFn: () => api.post(`/quotes/${id}/setup`), onSuccess: refresh });
  const d = q.data;
  const approval = d && d.discountPct > 0 ? td("approval", { pct: d.discountPct, state: d.approvedBy ? td("approved", { name: d.approvedBy }) : d.approvalStatus === "pending" ? td("approvalPending") : d.status === "draft" ? td("notApproved") : td("withinLimit") }) : null;
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={d ? `${d.number} · ${d.company}` : t("title")} description={d ? td("meta", { company: d.company, seats: fmt.num(d.seats), months: d.months, total: fmt.money(d.totalSatang) }) : undefined} wide>
      {q.isPending ? (
        <TableSkeleton rows={5} cols={2} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        d && (
          <div className="stack">
            <div className="row">
              <Pill tone={d.status === "accepted" ? "ok" : d.status === "sent" ? "inf" : d.status === "draft" ? "neu" : "bad"}>{t(`status.${d.status}`)}</Pill>
              {approval && <span className="small muted">{approval}</span>}
              {d.status === "sent" && <span className="small muted">{d.viewCount ? td("views", { n: d.viewCount, at: fmt.ago(d.lastViewedAt) }) : t("notViewed")}</span>}
            </div>
            {d.changeRequest && <Notice tone="warn">{td("change", { text: d.changeRequest })}</Notice>}
            {link && (
              <div className="stack-tight">
                <span className="field-label">{td("link")}</span>
                <div className="row">
                  <code className={`mono small ${styles.link}`}>{link}</code>
                  <CopyButton text={link} />
                </div>
              </div>
            )}
            {d.acceptance && <p className="small">{td("accepted", { name: d.acceptance.name, title: d.acceptance.title, at: fmt.dateTime(d.acceptedAt), po: d.acceptance.po ? ` · ${d.acceptance.po}` : "" })}</p>}
            {d.status === "accepted" && (
              <section className="stack-tight" aria-label={td("setup")}>
                <h3 className="card-title">{td("setup")}</h3>
                <ul className={styles.steps}>
                  {STEPS.map((k) => {
                    const st = d.setup[k];
                    const Icon = st?.status === "done" ? Check : st?.status === "failed" ? X : Clock;
                    return (
                      <li key={k}>
                        <Icon size={16} className={st?.status === "done" ? styles.ok : st?.status === "failed" ? styles.bad : styles.wait} aria-label={st ? td(`stepState.${st.status}`) : td("stepState.waiting")} />
                        <span>
                          {td(`steps.${k}`)}
                          {st?.error && <span className="muted small"> · {st.error}</span>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <div className="row">
                  {Object.values(d.setup).some((s) => s.status === "failed") && (
                    <Button size="small" disabled={retry.isPending} onClick={() => retry.mutate()}>
                      {td("retry")}
                    </Button>
                  )}
                  {!d.workspaceId && (
                    <Button size="small" variant="primary" onClick={() => setLinking(true)}>
                      {td("linkWs")}
                    </Button>
                  )}
                </div>
              </section>
            )}
            <InlineError error={send.error ?? copy.error ?? extend.error ?? retry.error} />
            <div className="dialog-actions">
              {d.status === "draft" && <Button onClick={() => setEditing(true)}>{td("edit")}</Button>}
              {(d.status === "expired" || d.status === "declined" || d.status === "sent") && (
                <Button disabled={copy.isPending} onClick={() => copy.mutate()}>
                  {td("copy")}
                </Button>
              )}
              {(d.status === "sent" || d.status === "expired") && (
                <Button disabled={extend.isPending} onClick={() => extend.mutate()}>
                  {t("extend")}
                </Button>
              )}
              {(d.status === "draft" || d.status === "sent") && (
                <Button variant="primary" disabled={send.isPending || d.approvalStatus === "pending"} onClick={() => send.mutate()}>
                  {d.status === "sent" ? td("resend") : td("send")}
                </Button>
              )}
            </div>
          </div>
        )
      )}
      {editing && d && <QuoteEditor quote={d} onClose={() => setEditing(false)} onSaved={() => refresh()} />}
      {linking && d && <LinkWorkspace id={d.id} onClose={() => setLinking(false)} onDone={refresh} />}
    </Drawer>
  );
}

function LinkWorkspace({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const td = useTranslations("quotes.drawer");
  const toast = useToast();
  const [search, setSearch] = useState("");
  const term = useDeferredValue(search.trim());
  const found = useQuery({ queryKey: ["ops", "ws-pick", term], queryFn: () => api.get<{ items: { id: string; name: string; slug: string }[] }>(`/workspaces?q=${encodeURIComponent(term)}&limit=6`), enabled: term.length >= 2 });
  const m = useMutation({ mutationFn: (workspaceId: string) => api.post(`/quotes/${id}/workspace`, { workspaceId }), onSuccess: () => (toast(td("linked")), onDone(), onClose()) });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={td("linkWsTitle")}>
      <div className="dialog-body">
        <Input label={td("wsSearch")} value={search} onChange={(e) => setSearch(e.target.value)} />
        {found.data?.items.map((w) => (
          <button key={w.id} type="button" className="menu-item" disabled={m.isPending} onClick={() => m.mutate(w.id)}>
            {w.name} · {w.slug}
          </button>
        ))}
        <InlineError error={m.error} />
      </div>
    </Modal>
  );
}
