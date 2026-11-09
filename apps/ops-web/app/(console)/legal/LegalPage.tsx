"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { hasAny } from "@/components/access";
import { ConfirmDialog, useReauth } from "@/components/dialogs";
import { Drawer, Empty, ErrorBlock, NoAccess, Notice, PageHead, Seg, TableSkeleton } from "@/components/kit";
import { Button, buttonClass, InlineError, Input, Select, Textarea, useToast } from "@/components/ui";
import { api, OPS_BASE } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useFmt } from "../workspaces/_parts/format";
import { lineDiff } from "./diff";

const DOC_TYPES = ["terms", "privacy", "dpa", "cookie", "subprocessors"] as const;
type DocType = (typeof DOC_TYPES)[number];
type Locale = "th" | "en";
/** หน้าเอกสารที่ลูกค้าเห็น (apps/web › /legal/[type]) */
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://fridaymanage.com";

interface DocRow {
  id: string;
  docType: DocType;
  version: string;
  locale: Locale;
  effectiveAt: string;
  summary: string | null;
  requiresAcceptance: boolean;
  createdAt: string;
  createdBy: string | null;
  accepted: number;
}
interface Group {
  docType: DocType;
  locale: Locale;
  current: (DocRow & { pendingUsers: number | null }) | null;
  scheduled: DocRow[];
  history: DocRow[];
}
interface Acceptance {
  id: string;
  acceptedAt: string;
  email: string;
  displayName: string | null;
  workspace: string | null;
  workspaceName: string | null;
  docType: DocType;
  version: string;
  locale: Locale;
  ip: string | null;
  channel: "signup" | "in_app";
}
const key = ["ops", "legal"] as const;

/** หน้า 11 · เอกสารกฎหมาย (Legal.dc.html · A7) · Owner สร้าง / ยกเลิกเวอร์ชัน (แตะกุญแจ) · ผู้ตรวจอ่าน */
export function LegalPage() {
  const t = useTranslations("pl.legal");
  const me = useMe().data;
  const owner = hasAny(me, "owner");
  const read = hasAny(me, "owner", "auditor");
  const q = useQuery({ queryKey: [...key, "documents"], queryFn: () => api.get<{ items: Group[]; activeUsers: number }>("/legal/documents"), enabled: !!me && read });
  const [sel, setSel] = useState(0);
  const [creating, setCreating] = useState(false);
  if (me && !read) return <NoAccess need={["owner", "auditor"]} />;
  const groups = q.data?.items ?? [];
  const g = groups[Math.min(sel, groups.length - 1)];
  return (
    <>
      <PageHead
        title={t("title")}
        desc={t("desc")}
        actions={
          owner && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={16} /> {t("create")}
            </Button>
          )
        }
      />
      {q.isPending ? (
        <TableSkeleton rows={4} cols={3} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !groups.length ? (
        <section className="card">
          <Empty title={t("empty")} description={t("emptyDesc")} />
        </section>
      ) : (
        <>
          <div className="legal-split">
            <section className="card" style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 10, gap: 6 }} aria-label={t("title")}>
                {groups.map((x, i) => (
                  <li key={`${x.docType}-${x.locale}`}>
                    <button
                      type="button"
                      className="menu-item"
                      aria-current={g === x ? "true" : undefined}
                      style={{ alignItems: "flex-start", border: "1px solid var(--border)", background: g === x ? "var(--primary-soft)" : undefined }}
                      onClick={() => setSel(i)}
                    >
                      <DocLabel g={x} />
                    </button>
                  </li>
                ))}
              </ul>
              <div className="stack small" style={{ marginTop: "auto", padding: 14, borderTop: "1px solid var(--border)", gap: 8 }}>
                <span className="muted">{t("publicNote")}</span>
                {g && (
                  <a className={buttonClass("secondary", "small")} href={`${APP_URL}/legal/${g.docType}`} target="_blank" rel="noreferrer">
                    <ExternalLink size={14} /> {t("viewPublic")}
                  </a>
                )}
              </div>
            </section>
            {g && <DocPanel g={g} owner={owner} />}
          </div>
          <AcceptStats groups={groups} activeUsers={q.data.activeUsers} />
        </>
      )}
      <AcceptanceLog />
      {creating && <NewVersion groups={groups} onClose={() => setCreating(false)} />}
    </>
  );
}

function DocLabel({ g }: { g: Group }) {
  const t = useTranslations("pl.legal");
  const fmt = useFmt();
  const next = g.scheduled[g.scheduled.length - 1];
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <span className="row">
        <b>{t(`types.${g.docType}`)}</b>
        <span className="pill">{t(`locale.${g.locale}`)}</span>
        {next ? <span className="pill warn">{t("scheduledPill")}</span> : g.current && <span className="pill ok">{t("inUse")}</span>}
      </span>
      <span className="muted small">
        {g.current ? `v${g.current.version} · ${t("since", { date: fmt.date(g.current.effectiveAt) })}` : t("noneYet")}
        {next && ` · v${next.version} ${t("since", { date: fmt.date(next.effectiveAt) })}`}
      </span>
    </span>
  );
}

/** รายละเอียดเอกสารที่เลือก: ฉบับที่ตั้งเวลาไว้ (เทียบกับฉบับก่อน · ยกเลิกได้) หรือฉบับที่ใช้อยู่ */
function DocPanel({ g, owner }: { g: Group; owner: boolean }) {
  const t = useTranslations("pl.legal");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const doc = g.scheduled[g.scheduled.length - 1] ?? g.current;
  const [cancelling, setCancelling] = useState(false);
  const detail = useQuery({ queryKey: [...key, "doc", doc?.id], queryFn: () => api.get<{ document: { body: string }; previous: { version: string; body: string; effectiveAt: string } | null }>(`/legal/documents/${doc!.id}`), enabled: !!doc });
  if (!doc) return null;
  const scheduled = doc !== g.current;
  const name = t(`types.${g.docType}`);
  const diff = detail.data?.previous ? lineDiff(detail.data.previous.body, detail.data.document.body) : undefined;
  return (
    <section className="card stack" aria-label={name}>
      <div className="row">
        <h2 className="card-title">{scheduled ? t("scheduled", { name, version: doc.version }) : t("current", { name, version: doc.version })}</h2>
        <span className={scheduled ? "pill warn" : "pill ok"}>{scheduled ? t("scheduledPill") : t("inUse")}</span>
      </div>
      <div className="grid-2">
        <div className="field">
          <span className="field-label">{t("effective")}</span>
          <span>{fmt.dateTime(doc.effectiveAt)}</span>
        </div>
        <div className="field">
          <span className="field-label">{doc.requiresAcceptance ? t("requires") : t("notify")}</span>
          <span className="muted small">{t("acceptedN", { n: doc.accepted })}</span>
        </div>
      </div>
      {doc.summary && (
        <div className="field">
          <span className="field-label">{t("summary")}</span>
          <span>{doc.summary}</span>
        </div>
      )}
      {scheduled && doc.requiresAcceptance && <Notice tone="info" title={t("requiresNote")} />}
      {detail.isPending ? (
        <TableSkeleton rows={4} cols={1} />
      ) : detail.error ? (
        <ErrorBlock error={detail.error} retry={() => void detail.refetch()} />
      ) : !detail.data.previous ? (
        <p className="muted small">{t("firstVersion")}</p>
      ) : (
        <div className="field">
          <span className="field-label">{t("compare", { version: detail.data.previous.version, date: fmt.date(detail.data.previous.effectiveAt) })}</span>
          {diff === null ? (
            <p className="muted small">{t("tooLong")}</p>
          ) : (
            <pre className="diff" aria-label={t("compare", { version: detail.data.previous.version, date: fmt.date(detail.data.previous.effectiveAt) })}>
              {diff!.map((l, i) =>
                l.kind === "skip" ? (
                  <span key={i} className="diff-same">
                    {t("same", { n: l.count })}
                  </span>
                ) : l.kind === "add" ? (
                  <ins key={i}>{l.text || " "}</ins>
                ) : l.kind === "del" ? (
                  <del key={i}>{l.text || " "}</del>
                ) : (
                  <span key={i} style={{ display: "block" }}>
                    {l.text || " "}
                  </span>
                ),
              )}
            </pre>
          )}
        </div>
      )}
      {!scheduled && g.history.length > 1 && (
        <details>
          <summary className="small">{t("history")}</summary>
          {g.history.slice(1).map((h) => (
            <div key={h.id} className="small">
              v{h.version} · {t("since", { date: fmt.date(h.effectiveAt) })} · {t("acceptedN", { n: h.accepted })}
            </div>
          ))}
        </details>
      )}
      {scheduled && owner && (
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={() => setCancelling(true)}>
            {t("cancel")}
          </Button>
        </div>
      )}
      {cancelling && (
        <ConfirmDialog
          open
          danger
          minReason={0}
          onOpenChange={() => setCancelling(false)}
          title={t("cancelTitle", { name, version: doc.version })}
          description={t("cancelDesc")}
          onConfirm={async () => {
            await run(() => api.delete(`/legal/documents/${doc.id}`), t("cancel"));
            toast(t("cancelled"));
            void cache.invalidateQueries({ queryKey: key });
          }}
        />
      )}
    </section>
  );
}

/** ตัวเลขการยอมรับ: ข้อกำหนดฉบับที่ใช้อยู่ · ยังไม่ยอมรับ · DPA · ฉบับที่ตั้งเวลาไว้ */
function AcceptStats({ groups, activeUsers }: { groups: Group[]; activeUsers: number }) {
  const t = useTranslations("pl.legal");
  const fmt = useFmt();
  const terms = groups.find((g) => g.docType === "terms" && g.locale === "th")?.current ?? groups.find((g) => g.docType === "terms")?.current;
  const dpa = groups.filter((g) => g.docType === "dpa").reduce((n, g) => n + (g.current?.accepted ?? 0), 0);
  const scheduled = groups.reduce((n, g) => n + g.scheduled.length, 0);
  const pct = terms && activeUsers ? Math.round((terms.accepted / activeUsers) * 1000) / 10 : null;
  return (
    <section className="stats">
      <div className="stat">
        <span className="muted small">{terms ? t("stats.accepted", { name: t("types.terms"), version: terms.version }) : t("types.terms")}</span>
        <b>{pct == null ? "—" : `${pct}%`}</b>
        <span className="muted small">{terms ? t("stats.acceptedNote", { n: fmt.num(terms.accepted), total: fmt.num(activeUsers) }) : t("noneYet")}</span>
      </div>
      <div className={terms?.pendingUsers ? "stat stat-warn" : "stat"}>
        <span className="muted small">{t("stats.pending")}</span>
        <b>{terms?.pendingUsers == null ? "—" : fmt.num(terms.pendingUsers)}</b>
        <span className="muted small">{t("stats.pendingNote")}</span>
      </div>
      <div className="stat">
        <span className="muted small">{t("stats.dpa")}</span>
        <b>{fmt.num(dpa)}</b>
        <span className="muted small">{t("stats.dpaNote")}</span>
      </div>
      <div className="stat">
        <span className="muted small">{t("stats.scheduled")}</span>
        <b>{scheduled}</b>
        <span className="muted small">{t("stats.scheduledNote")}</span>
      </div>
    </section>
  );
}

/** ประวัติการยอมรับ · ค้นด้วยอีเมล / Workspace · ส่งออก CSV ตามตัวกรอง */
function AcceptanceLog() {
  const t = useTranslations("pl.legal");
  const fmt = useFmt();
  const [q, setQ] = useState("");
  const [doc, setDoc] = useState<DocType | "">("");
  const search = useDeferredValue(q.trim());
  const filter = new URLSearchParams({ ...(search ? { q: search } : {}), ...(doc ? { docType: doc } : {}) });
  const list = useQuery({ queryKey: [...key, "acceptances", filter.toString()], queryFn: () => api.get<{ items: Acceptance[] }>(`/legal/acceptances?${filter}`) });
  return (
    <section className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div className="card-head" style={{ padding: "14px 16px", margin: 0, borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
        <h2 className="card-title">{t("log")}</h2>
        <span className="card-sub">{t("logSub")}</span>
        <span className="spacer" />
        <Input aria-label={t("search")} placeholder={t("search")} value={q} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label={t("allDocs")} style={{ width: "auto", minWidth: 180 }} value={doc} onChange={(e) => setDoc(e.target.value as DocType | "")}>
          <option value="">{t("allDocs")}</option>
          {DOC_TYPES.map((d) => (
            <option key={d} value={d}>
              {t(`types.${d}`)}
            </option>
          ))}
        </Select>
        <a className={buttonClass("secondary", "small")} href={`${OPS_BASE}/legal/acceptances/export?${filter}`} download>
          <Download size={14} /> {t("export")}
        </a>
      </div>
      {list.isPending ? (
        <TableSkeleton rows={4} cols={7} />
      ) : list.error ? (
        <ErrorBlock error={list.error} retry={() => void list.refetch()} />
      ) : !list.data.items.length ? (
        <Empty title={t("noLog")} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                {(["time", "user", "ws", "doc", "ver", "via", "ip"] as const).map((c) => (
                  <th key={c}>{t(`col.${c}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((a) => (
                <tr key={a.id}>
                  <td className="small num">{fmt.dateTime(a.acceptedAt)}</td>
                  <td className="small">{a.email}</td>
                  <td className="small">{a.workspaceName ?? "—"}</td>
                  <td className="small">{t(`types.${a.docType}`)}</td>
                  <td className="small">v{a.version}</td>
                  <td className="small">{t(`via.${a.channel}`)}</td>
                  <td className="mono small">{a.ip ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const nextVersion = (v: string | undefined) => (v ? String(Math.floor(Number(v.split(".")[0])) + 1) : "1");
/** วันที่มีผลเร็วสุด (เวลาไทย): ต้องยอมรับใหม่ = อีก 31 วัน · แจ้งให้ทราบ = วันนี้ */
const minEffective = (requires: boolean) => new Date(Date.now() + 7 * 3_600_000 + (requires ? 31 : 0) * 86_400_000).toISOString().slice(0, 10);
/** วันนี้ = มีผลทันที · วันอื่น = เที่ยงคืนเวลาไทย */
const effectiveIso = (date: string) => (date === minEffective(false) ? new Date().toISOString() : new Date(`${date}T00:00:00+07:00`).toISOString());

/** A7 · สร้างเวอร์ชันใหม่และตั้งเวลาเผยแพร่ (Owner · แตะกุญแจ) */
function NewVersion({ groups, onClose }: { groups: Group[]; onClose: () => void }) {
  const t = useTranslations("pl.a7");
  const tl = useTranslations("pl.legal");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const [docType, setDocType] = useState<DocType>("terms");
  const [locale, setLocale] = useState<Locale>("th");
  const g = groups.find((x) => x.docType === docType && x.locale === locale);
  const latest = g?.scheduled[0] ?? g?.current ?? undefined;
  const [version, setVersion] = useState(nextVersion(latest?.version));
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [requires, setRequires] = useState(true);
  const [effective, setEffective] = useState(minEffective(true));
  const pick = (d: DocType, l: Locale) => {
    setDocType(d);
    setLocale(l);
    const x = groups.find((y) => y.docType === d && y.locale === l);
    setVersion(nextVersion((x?.scheduled[0] ?? x?.current)?.version));
  };
  const ok = /^\d+(\.\d+)*$/.test(version.trim()) && summary.trim().length >= 10 && body.trim().length >= 50 && !!effective;
  const m = useMutation({
    mutationFn: () => run(() => api.post("/legal/documents", { docType, locale, version: version.trim(), summary: summary.trim(), body: body.trim(), requiresAcceptance: requires, effectiveAt: effectiveIso(effective) }), t("reauth")),
    onSuccess: () => (toast(t("done", { name: tl(`types.${docType}`), version: version.trim() })), void cache.invalidateQueries({ queryKey: key }), onClose()),
  });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={t("title")} description={g?.current ? t("currentVersion", { version: g.current.version, date: fmt.date(g.current.effectiveAt) }) : t("noCurrent")}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <div className="grid-2">
          <Select label={t("doc")} value={docType} onChange={(e) => pick(e.target.value as DocType, locale)}>
            {DOC_TYPES.map((d) => (
              <option key={d} value={d}>
                {tl(`types.${d}`)}
              </option>
            ))}
          </Select>
          <Input label={t("version")} value={version} onChange={(e) => setVersion(e.target.value)} />
        </div>
        <div className="field">
          <span className="field-label">{t("locale")}</span>
          <Seg label={t("locale")} value={locale} onChange={(l) => pick(docType, l)} options={(["th", "en"] as const).map((l) => ({ value: l, label: tl(`locale.${l}`) }))} />
        </div>
        <Textarea label={t("body")} value={body} rows={8} onChange={(e) => setBody(e.target.value)} />
        <label className={buttonClass("secondary", "small")} style={{ alignSelf: "flex-start" }}>
          {t("file")}
          <input
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void f.text().then(setBody);
            }}
          />
        </label>
        <Textarea label={t("summary")} value={summary} onChange={(e) => setSummary(e.target.value)} />
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">{t("existing")}</legend>
          {([true, false] as const).map((v) => (
            <label key={String(v)} className="check">
              <input
                type="radio"
                name="a7-requires"
                checked={requires === v}
                onChange={() => {
                  setRequires(v);
                  if (effective < minEffective(v)) setEffective(minEffective(v));
                }}
              />
              <span>
                <b>{v ? t("requires") : t("notify")}</b> <span className="muted small">{v ? t("requiresDesc") : t("notifyDesc")}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Input label={t("effective")} type="date" min={minEffective(requires)} hint={requires ? t("minNotice") : undefined} value={effective} onChange={(e) => setEffective(e.target.value)} />
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
