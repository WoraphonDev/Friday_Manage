"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { hasAny } from "@/components/access";
import { Chip, Empty, ErrorBlock, TableSkeleton } from "@/components/kit";
import { Button, buttonClass, errorToast, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { healthTone, planLabel, useFmt } from "./format";
import type { Member, Overview } from "./types";

/** โหลดข้อมูลของแท็บ · แต่ละแท็บล้มได้เฉพาะส่วน (S6) */
function useTab<T>(id: string, tab: string) {
  return useQuery({ queryKey: ["ops", "workspace", id, tab], queryFn: () => api.get<T>(`/workspaces/${id}/${tab}`) });
}
function Loaded<T>({ q, cols = 5, children }: { q: ReturnType<typeof useTab<T>>; cols?: number; children: (d: T) => React.ReactNode }) {
  if (q.isPending) return <TableSkeleton rows={4} cols={cols} />;
  if (q.error) return <ErrorBlock error={q.error} retry={() => void q.refetch()} />;
  return <>{children(q.data as T)}</>;
}
function Card({ title, sub, children, actions }: { title: string; sub?: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{title}</h2>
        {sub && <span className="card-sub">{sub}</span>}
        {actions && (
          <>
            <span className="spacer" />
            {actions}
          </>
        )}
      </div>
      {children}
    </section>
  );
}
function Table({ head, children, label }: { head: string[]; children: React.ReactNode; label?: string }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl" aria-label={label}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- ภาพรวม

export function OverviewPanel({ ws }: { ws: Overview }) {
  const t = useTranslations("customers");
  const fmt = useFmt();
  const sub = ws.subscription;
  return (
    <div className="grid-2">
      <Card title={t("overview.dau")} sub={t("overview.dauNote", { n: ws.usage.active30, last: fmt.ago(ws.usage.lastActiveAt) })}>
        <div className="row small">
          <span className="muted">{t("overview.top")}</span>
          {ws.topFeatures.length ? ws.topFeatures.map((f) => <span key={f} className="pill inf">{f}</span>) : "—"}
        </div>
        <div className="row small">
          <span className="muted">{t("overview.unused")}</span>
          {ws.unusedFeatures.map((f) => (
            <span key={f} className="pill">
              {f}
            </span>
          ))}
        </div>
      </Card>
      <Card title={t("overview.healthTitle", { score: ws.health.score })} sub={t("overview.healthNote")}>
        {(["usage", "payment", "support", "growth"] as const).map((k) => (
          <div key={k} className="row" style={{ justifyContent: "space-between" }}>
            <span>{t(`overview.parts.${k}`)}</span>
            <span className={`pill ${healthTone(ws.health.parts[k])}`}>{ws.health.parts[k]}</span>
          </div>
        ))}
      </Card>
      <Card title={t("overview.billingTitle")}>
        <table className="tbl">
          <tbody>
            <tr>
              <td className="muted">{t("overview.planLabel")}</td>
              <td>
                {planLabel(sub?.plan)} · {t("overview.seatsOf", { seats: ws.usage.members, limit: sub?.seatLimit ?? "∞" })}
              </td>
            </tr>
            <tr>
              <td className="muted">{t("overview.nextCycle")}</td>
              <td>{fmt.date(sub?.currentPeriodEnd)}</td>
            </tr>
            <tr>
              <td className="muted">{t("overview.method")}</td>
              <td>{sub?.paymentMethod ?? t("overview.none")}</td>
            </tr>
            <tr>
              <td className="muted">{t("overview.discount")}</td>
              <td>
                {sub?.discount?.percent != null
                  ? t("overview.discountValue", { pct: sub.discount.percent, months: sub.discount.months ? t("overview.monthsLeft", { n: sub.discount.months }) : t("overview.forever") })
                  : sub?.discount?.active
                    ? "✓"
                    : t("overview.none")}
              </td>
            </tr>
          </tbody>
        </table>
      </Card>
      {ws.economics && (
        <Card title={t("overview.profit")}>
          <div className="row" style={{ gap: 24 }}>
            <div>
              <div className="muted small">{t("overview.gross")}</div>
              <div className="page-title">{ws.economics.marginPct == null ? "—" : `${ws.economics.marginPct}%`}</div>
            </div>
            <div>
              <div className="muted small">{t("overview.revenue")}</div>
              <b>{fmt.money(ws.economics.revenueSatang)}</b>
            </div>
            <div>
              <div className="muted small">{t("overview.cost")}</div>
              <b>{fmt.money(ws.economics.costSatang)}</b>
            </div>
          </div>
          <div className="row small">
            {Object.entries(ws.economics.costs).map(([k, v]) => (
              <span key={k} className="pill">
                {t.has(`overview.costs.${k}` as "overview.costs.emails") ? t(`overview.costs.${k}` as "overview.costs.emails") : k} {fmt.money(v.satang)}
              </span>
            ))}
          </div>
        </Card>
      )}
      <Card title={t("overview.signals")} sub={t("overview.signalsCount", { n: ws.upgradeSignals.length })}>
        {ws.upgradeSignals.length ? (
          <ul className="stack small" style={{ margin: 0, paddingLeft: 18 }}>
            {ws.upgradeSignals.map((s) => (
              <li key={s.code}>{s.message}</li>
            ))}
          </ul>
        ) : (
          <p className="muted small">{t("overview.noSignals")}</p>
        )}
        {ws.acquisition && (
          <div className="small">
            <span className="muted">{t("overview.source")}: </span>
            {[ws.acquisition.source, ws.acquisition.medium, ws.acquisition.campaign].filter(Boolean).join(" / ") || t(`overview.via.${ws.acquisition.via}` as "overview.via.signup")}
          </div>
        )}
      </Card>
      <Notes ws={ws} />
    </div>
  );
}

function Notes({ ws }: { ws: Overview }) {
  const t = useTranslations("customers.overview");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const me = useMe().data;
  const [text, setText] = useState("");
  const add = useMutation({
    mutationFn: () => api.post(`/workspaces/${ws.id}/notes`, { text: text.trim() }),
    onSuccess: () => {
      setText("");
      toast(t("noteSaved"));
      void cache.invalidateQueries({ queryKey: ["ops", "workspace", ws.id] });
    },
    onError: (e) => toast(errorToast(e)),
  });
  return (
    <Card title={t("notes")} sub={t("notesHidden")}>
      {ws.notes.length ? (
        ws.notes.map((n) => (
          <div key={n.id} className="small">
            <div>{n.text}</div>
            <div className="muted">
              — {n.staffName ?? "—"}, {fmt.date(n.createdAt)}
            </div>
          </div>
        ))
      ) : (
        <p className="muted small">{t("noNotes")}</p>
      )}
      {hasAny(me, "owner", "finance", "support") && (
        <form className="stack" onSubmit={(e) => (e.preventDefault(), text.trim() && add.mutate())}>
          <Textarea aria-label={t("addNote")} placeholder={t("notePlaceholder")} value={text} onChange={(e) => setText(e.target.value)} />
          <div>
            <Button type="submit" size="small" disabled={!text.trim() || add.isPending}>
              {t("saveNote")}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- การใช้งาน

interface Usage {
  limits: { key: "seats" | "storage_bytes" | "projects"; used: number; max: number | null }[];
  dailyActiveUsers: { date: string; activeUsers: number }[];
  averageDailyActive: number;
  features: { feature: string; users: number; times: number; lastUsedAt: string }[];
  imports: { id: string; kind: string; at: string; project: string | null; file: string; status: string; rows: number | null; by: string | null }[];
}
export function UsagePanel({ id }: { id: string }) {
  const t = useTranslations("customers.usage");
  const fmt = useFmt();
  const q = useTab<Usage>(id, "usage");
  return (
    <Loaded q={q}>
      {(d) => {
        const peak = Math.max(1, ...d.dailyActiveUsers.map((x) => x.activeUsers));
        return (
          <div className="stack">
            <Card title={t("limits")}>
              <Table head={[t("limit"), t("used"), t("max")]}>
                {d.limits.map((l) => (
                  <tr key={l.key}>
                    <td>{t(`keys.${l.key}`)}</td>
                    <td className="num">{l.key === "storage_bytes" ? fmt.bytes(l.used) : l.used}</td>
                    <td className="num">{l.max == null ? t("unlimited") : l.key === "storage_bytes" ? fmt.bytes(l.max) : l.max}</td>
                  </tr>
                ))}
              </Table>
            </Card>
            <Card title={t("daily")} sub={t("avg", { n: d.averageDailyActive })}>
              {d.dailyActiveUsers.length ? (
                <div role="img" aria-label={t("avg", { n: d.averageDailyActive })} style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 80 }}>
                  {d.dailyActiveUsers.map((x) => (
                    <span key={x.date} title={`${x.date}: ${x.activeUsers}`} style={{ flex: 1, height: `${(x.activeUsers / peak) * 100}%`, minHeight: 2, background: "var(--chart-primary)", borderRadius: "3px 3px 0 0" }} />
                  ))}
                </div>
              ) : (
                <p className="muted small">{t("noData")}</p>
              )}
            </Card>
            <Card title={t("features")} sub={t("featuresNote")}>
              {d.features.length ? (
                <Table head={[t("feature"), t("users"), t("times"), t("last")]}>
                  {d.features.map((f) => (
                    <tr key={f.feature}>
                      <td>{f.feature}</td>
                      <td className="num">{f.users}</td>
                      <td className="num">{f.times}</td>
                      <td>{fmt.ago(f.lastUsedAt)}</td>
                    </tr>
                  ))}
                </Table>
              ) : (
                <p className="muted small">{t("noData")}</p>
              )}
            </Card>
            <Card title={t("imports")} sub={t("importsNote")}>
              {d.imports.length ? (
                <Table head={[t("time"), t("project"), t("file"), t("result"), t("by")]}>
                  {d.imports.map((i) => (
                    <tr key={i.id}>
                      <td>{fmt.dateTime(i.at)}</td>
                      <td>{i.project ?? "—"}</td>
                      <td className="mono small">{i.file}</td>
                      <td>
                        <span className={i.status === "completed" ? "pill ok" : i.status === "failed" ? "pill bad" : "pill"}>{i.status}</span> {i.rows ?? ""}
                      </td>
                      <td>{i.by ?? "—"}</td>
                    </tr>
                  ))}
                </Table>
              ) : (
                <p className="muted small">{t("noData")}</p>
              )}
            </Card>
          </div>
        );
      }}
    </Loaded>
  );
}

// ---------------------------------------------------------------- โปรเจกต์

interface Projects {
  items: { id: string; key: string; name: string; template: string | null; members: number; issuesTotal: number; issuesOpen: number; progress: number; goliveDate: string | null; lastActivityAt: string | null; archivedAt: string | null }[];
  active: number;
  archived: number;
}
export function ProjectsPanel({ id }: { id: string }) {
  const t = useTranslations("customers.projects");
  const fmt = useFmt();
  const q = useTab<Projects>(id, "projects");
  return (
    <Loaded q={q}>
      {(d) => (
        <Card title={t("name")} sub={t("summary", { active: d.active, archived: d.archived })}>
          {d.items.length ? (
            <Table head={[t("name"), t("template"), t("members"), t("issues"), t("progress"), t("golive"), t("activity")]}>
              {d.items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className="cell-main">
                      {p.key} · {p.name}
                    </span>{" "}
                    {p.archivedAt && <span className="pill">{t("archived")}</span>}
                  </td>
                  <td>{p.template ?? "—"}</td>
                  <td className="num">{p.members}</td>
                  <td className="num">
                    {p.issuesOpen} / {p.issuesTotal}
                  </td>
                  <td className="num">{p.progress}%</td>
                  <td>{fmt.date(p.goliveDate)}</td>
                  <td>{fmt.ago(p.lastActivityAt)}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty title={t("empty")} />
          )}
        </Card>
      )}
    </Loaded>
  );
}

// ---------------------------------------------------------------- ผู้ใช้

interface Members {
  seats: number;
  items: Member[];
  invitations: { id: string; email: string | null; role: string; sentAt: string }[];
  inviteLinks: { active: number; nextExpiry: string | null };
}
export function useMembers(id: string) {
  return useTab<Members>(id, "members");
}
export function MembersPanel({ id, guests, onTransfer }: { id: string; guests: number; onTransfer?: () => void }) {
  const t = useTranslations("customers.members");
  const fmt = useFmt();
  const q = useMembers(id);
  return (
    <Loaded q={q} cols={7}>
      {(d) => (
        <Card title={t("summary", { seats: d.seats, guests })} sub={t("seatNote")} actions={onTransfer && <Button size="small" onClick={onTransfer}>{t("transfer")}</Button>}>
          <Table head={[t("name"), t("role"), t("title"), t("login"), t("mfa"), t("last"), t("status"), t("actions")]}>
            {d.items.map((m) => (
              <tr key={m.id}>
                <td>
                  <div className="cell-main">{m.displayName}</div>
                  {m.email && <div className="cell-sub">{m.email}</div>}
                </td>
                <td>{t(`roles.${m.role}`)}</td>
                <td>{m.jobTitle ?? "—"}</td>
                <td className="small">{m.login.map((l) => (t.has(`logins.${l}` as "logins.google") ? t(`logins.${l}` as "logins.google") : l)).join(", ") || "—"}</td>
                <td>{m.mfaEnabled ? <span className="pill ok">{t("on")}</span> : <span className="pill">{t("off")}</span>}</td>
                <td>{fmt.ago(m.lastActiveAt)}</td>
                <td>
                  {m.disabled ? <span className="pill bad">{t("disabled")}</span> : m.locked ? <span className="pill warn">{t("locked")}</span> : m.status === "deactivated" ? <span className="pill">{t("deactivated")}</span> : <span className="pill ok">{t("active")}</span>}
                </td>
                <td>
                  <Link className={buttonClass("ghost", "small")} href={`/users?id=${m.id}`}>
                    {t("openUser")}
                  </Link>
                </td>
              </tr>
            ))}
          </Table>
          <div className="muted small">
            {t("invites", { n: d.invitations.length })}
            {d.invitations.map((i) => ` · ${i.email ?? "—"}`).join("")} · {t("links", { n: d.inviteLinks.active })}
          </div>
        </Card>
      )}
    </Loaded>
  );
}

// ---------------------------------------------------------------- การเชื่อมต่อ

interface Integrations {
  webhooks: { id: string; name: string; format: string; status: string; urlLast4: string; failures: number }[];
  deliveries7d: { channel: string; sent: number; total: number }[];
  apiTokens: { id: string; name: string; scopes: string[]; lastUsedAt: string | null; revokedAt: string | null; createdBy: string | null }[];
  line: { channelId: string } | null;
  git: { id: string; provider: string; accountName: string; status: string }[];
  automation: { enabled: number; total: number };
}
export function IntegrationsPanel({ id }: { id: string }) {
  const t = useTranslations("customers.integrations");
  const fmt = useFmt();
  const q = useTab<Integrations>(id, "integrations");
  return (
    <Loaded q={q}>
      {(d) => (
        <div className="stack">
          <Card title={t("webhooks")}>
            {d.webhooks.length ? (
              <Table head={[t("name"), t("format"), t("status"), t("failures")]}>
                {d.webhooks.map((w) => (
                  <tr key={w.id}>
                    <td>
                      {w.name} <span className="muted mono small">…{w.urlLast4}</span>
                    </td>
                    <td>{w.format}</td>
                    <td>
                      <span className={w.status === "active" ? "pill ok" : "pill warn"}>{w.status}</span>
                    </td>
                    <td className="num">{w.failures}</td>
                  </tr>
                ))}
              </Table>
            ) : (
              <p className="muted small">{t("none")}</p>
            )}
            <div className="row small">
              <span className="muted">{t("deliveries")}:</span>
              {d.deliveries7d.map((x) => (
                <span key={x.channel} className="pill">
                  {x.channel} {t("sent", { sent: x.sent, total: x.total })}
                </span>
              ))}
            </div>
          </Card>
          <Card title={t("tokens")} sub={t("tokensNote")}>
            {d.apiTokens.length ? (
              <Table head={[t("name"), t("scopes"), t("createdBy"), t("lastUsed")]}>
                {d.apiTokens.map((k) => (
                  <tr key={k.id}>
                    <td>
                      {k.name} {k.revokedAt && <span className="pill">{t("revoked")}</span>}
                    </td>
                    <td className="small">{k.scopes.join(", ")}</td>
                    <td>{k.createdBy ?? "—"}</td>
                    <td>{fmt.ago(k.lastUsedAt)}</td>
                  </tr>
                ))}
              </Table>
            ) : (
              <p className="muted small">{t("none")}</p>
            )}
          </Card>
          <div className="grid-2">
            <Card title={t("line")}>{d.line ? <span className="pill ok">{t("lineOn", { id: d.line.channelId })}</span> : <p className="muted small">{t("none")}</p>}</Card>
            <Card title={t("git")}>
              {d.git.length ? d.git.map((g) => <div key={g.id}>{`${g.provider} · ${g.accountName} · ${g.status}`}</div>) : <p className="muted small">{t("none")}</p>}
              <div className="small muted">{t("automation", d.automation)}</div>
            </Card>
          </div>
        </div>
      )}
    </Loaded>
  );
}

// ---------------------------------------------------------------- ความปลอดภัย

interface Security {
  policy: { mfaEnforcement?: string; passwordMinLength?: number; lockoutAttempts?: number; sessionIdleHours?: number; ipAllowlistCount: number; allowedEmailDomains: string[] | null } | null;
  events: { id: string; at: string; action: string; actorKind: string; summary: string | null; ip: string | null }[];
}
export function SecurityPanel({ id }: { id: string }) {
  const t = useTranslations("customers.security");
  const fmt = useFmt();
  const q = useTab<Security>(id, "security");
  return (
    <Loaded q={q}>
      {(d) => (
        <div className="grid-2">
          <Card title={t("policy")}>
            {d.policy ? (
              <ul className="stack small" style={{ margin: 0, paddingLeft: 18 }}>
                <li>
                  {t("mfa")}: {d.policy.mfaEnforcement ?? "—"}
                </li>
                {d.policy.passwordMinLength != null && <li>{t("password", { n: d.policy.passwordMinLength })}</li>}
                {d.policy.lockoutAttempts != null && <li>{t("lockout", { n: d.policy.lockoutAttempts })}</li>}
                {d.policy.sessionIdleHours != null && <li>{t("idle", { n: d.policy.sessionIdleHours })}</li>}
                <li>{t("ipAllow", { n: d.policy.ipAllowlistCount })}</li>
                {d.policy.allowedEmailDomains?.length ? (
                  <li>
                    {t("domains")}: {d.policy.allowedEmailDomains.join(", ")}
                  </li>
                ) : null}
              </ul>
            ) : (
              <p className="muted small">{t("noPolicy")}</p>
            )}
          </Card>
          <Card title={t("events")}>
            {d.events.length ? (
              d.events.map((e) => (
                <div key={e.id} className="small">
                  <span className="muted">{fmt.dateTime(e.at)}</span> · {e.summary ?? e.action}
                </div>
              ))
            ) : (
              <p className="muted small">—</p>
            )}
          </Card>
        </div>
      )}
    </Loaded>
  );
}

// ---------------------------------------------------------------- การเงิน

interface Billing {
  profile: { companyName: string; taxId?: string; branchType?: string; branchNo?: string | null; address?: string; taxEmail?: string; whtEnabled?: boolean } | null;
  paymentState: "ok" | "overdue";
  onTime: { paid: number; onTime: number };
  invoices: { id: string; number: string; periodStart: string; status: string; total: number | null; method: string | null; hasTaxDocument: boolean }[];
  history: { at: string; kind: string; planFrom: string | null; planTo: string | null; mrrBefore?: number; mrrAfter?: number }[];
  creditBalanceSatang: number | null;
}
export function BillingPanel({ id }: { id: string }) {
  const t = useTranslations("customers.billing");
  const fmt = useFmt();
  const q = useTab<Billing>(id, "billing");
  return (
    <Loaded q={q}>
      {(d) => (
        <div className="stack">
          <div className="grid-2">
            <Card title={t("profile")}>
              {d.profile ? (
                <table className="tbl">
                  <tbody>
                    <tr>
                      <td className="muted">{t("company")}</td>
                      <td>{d.profile.companyName}</td>
                    </tr>
                    {d.profile.taxId && (
                      <>
                        <tr>
                          <td className="muted">{t("taxId")}</td>
                          <td className="mono">{d.profile.taxId}</td>
                        </tr>
                        <tr>
                          <td className="muted">{t("branch")}</td>
                          <td>{d.profile.branchType === "head" ? t("head") : d.profile.branchNo}</td>
                        </tr>
                        <tr>
                          <td className="muted">{t("taxEmail")}</td>
                          <td>{d.profile.taxEmail}</td>
                        </tr>
                        <tr>
                          <td className="muted">{t("wht")}</td>
                          <td>{d.profile.whtEnabled ? t("whtOn") : t("whtOff")}</td>
                        </tr>
                      </>
                    )}
                  </tbody>
                </table>
              ) : (
                <p className="muted small">{t("noProfile")}</p>
              )}
            </Card>
            <Card title={t("paymentState.ok")}>
              <span className={d.paymentState === "ok" ? "pill ok" : "pill bad"}>{t(`paymentState.${d.paymentState}`)}</span>
              <div className="small">{t("onTime", d.onTime)}</div>
              {d.creditBalanceSatang != null && (
                <div className="small">
                  {t("credit")}: <b>{fmt.money(d.creditBalanceSatang)}</b>
                </div>
              )}
            </Card>
          </div>
          <Card title={t("invoices")}>
            <Table head={[t("number"), t("period"), t("amount"), t("status"), t("channel"), t("doc")]}>
              {d.invoices.map((i) => (
                <tr key={i.id}>
                  <td className="mono small">{i.number}</td>
                  <td>{fmt.date(i.periodStart)}</td>
                  <td className="num">{i.total == null ? <span className="muted small">{t("hidden")}</span> : fmt.money(i.total)}</td>
                  <td>
                    <span className={i.status === "paid" ? "pill ok" : i.status === "void" ? "pill" : "pill warn"}>{t.has(`invStatus.${i.status}` as "invStatus.paid") ? t(`invStatus.${i.status}` as "invStatus.paid") : i.status}</span>
                  </td>
                  <td>{i.method ?? "—"}</td>
                  <td>{i.hasTaxDocument ? "✓" : "—"}</td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card title={t("history")}>
            <Table head={[t("date"), t("item"), t("detail")]}>
              {d.history.map((h, i) => (
                <tr key={i}>
                  <td>{fmt.date(h.at)}</td>
                  <td>{t.has(`kinds.${h.kind}` as "kinds.new") ? t(`kinds.${h.kind}` as "kinds.new") : h.kind}</td>
                  <td className="small">
                    {planLabel(h.planFrom)} → {planLabel(h.planTo)}
                    {h.mrrAfter != null && ` · MRR ${fmt.money(h.mrrAfter)}`}
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      )}
    </Loaded>
  );
}

// ---------------------------------------------------------------- Support

interface SupportData {
  tickets: { id: string; number: number; subject: string; status: string; createdAt: string; csat: number | null; assignee: string | null }[];
  csatAverage: number | null;
  sessions: { id: string; ticketNo: string; mode: string; reason: string; startedAt: string; endedAt: string | null; expiresAt?: string | null; staffName: string }[];
}
export function SupportPanel({ id }: { id: string }) {
  const t = useTranslations("customers.support");
  const fmt = useFmt();
  const q = useTab<SupportData>(id, "support");
  return (
    <Loaded q={q}>
      {(d) => (
        <div className="stack">
          <Card title={t("tickets")} sub={d.csatAverage == null ? t("noCsat") : t("csat", { n: d.csatAverage })} actions={<Link className={buttonClass("ghost", "small")} href={`/support?workspace=${id}`}>{t("open")}</Link>}>
            {d.tickets.length ? (
              <Table head={["Ticket", t("subject"), t("assignee"), t("created"), t("status"), t("score")]}>
                {d.tickets.map((k) => (
                  <tr key={k.id}>
                    <td className="mono">#{k.number}</td>
                    <td>{k.subject}</td>
                    <td>{k.assignee ?? "—"}</td>
                    <td>{fmt.date(k.createdAt)}</td>
                    <td>
                      <span className="pill">{t.has(`tStatus.${k.status}` as "tStatus.open") ? t(`tStatus.${k.status}` as "tStatus.open") : k.status}</span>
                    </td>
                    <td className="num">{k.csat ?? "—"}</td>
                  </tr>
                ))}
              </Table>
            ) : (
              <p className="muted small">{t("noTickets")}</p>
            )}
          </Card>
          <Card title={t("sessions")}>
            {d.sessions.length ? (
              <Table head={[t("time"), t("sessionEnd"), t("staff"), "Ticket", t("mode"), t("reason")]}>
                {d.sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{fmt.dateTime(s.startedAt)}</td>
                    <td>{s.endedAt ? fmt.dateTime(s.endedAt) : <span className="pill warn">{s.expiresAt ? t("sessionUntil", { time: fmt.dateTime(s.expiresAt) }) : t("sessionOpen")}</span>}</td>
                    <td>{s.staffName}</td>
                    <td>{s.ticketNo}</td>
                    <td>{s.mode}</td>
                    <td className="small">{s.reason}</td>
                  </tr>
                ))}
              </Table>
            ) : (
              <p className="muted small">{t("noSessions")}</p>
            )}
          </Card>
        </div>
      )}
    </Loaded>
  );
}

// ---------------------------------------------------------------- Audit log

interface AuditPage {
  items: { id: string; at: string; actorKind: string; actorName: string | null; category: string; action: string; summary: string | null; friday: boolean }[];
  nextBefore: string | null;
}
export function AuditPanel({ id }: { id: string }) {
  const t = useTranslations("customers.audit");
  const fmt = useFmt();
  const [friday, setFriday] = useState(false);
  const q = useInfiniteQuery({
    queryKey: ["ops", "workspace", id, "audit", friday],
    queryFn: ({ pageParam }) => api.get<AuditPage>(`/workspaces/${id}/audit?limit=50${friday ? "&fridayOnly=true" : ""}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card title="Audit log" sub={t("note")} actions={<Chip pressed={friday} onClick={() => setFriday(!friday)}>{t("fridayOnly")}</Chip>}>
      {q.isPending ? (
        <TableSkeleton rows={4} cols={4} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !rows.length ? (
        <Empty title={t("empty")} />
      ) : (
        <>
          <Table head={[t("time"), t("actor"), t("category"), t("summary")]}>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="small" style={{ whiteSpace: "nowrap" }}>
                  {fmt.dateTime(r.at)}
                </td>
                <td>{r.friday ? <span className="pill inf">{t("friday")}</span> : (r.actorName ?? r.actorKind)}</td>
                <td>{t.has(`cats.${r.category}` as "cats.perm") ? t(`cats.${r.category}` as "cats.perm") : r.category}</td>
                <td className="small">{r.summary ?? r.action}</td>
              </tr>
            ))}
          </Table>
          {q.hasNextPage && (
            <Button size="small" onClick={() => void q.fetchNextPage()}>
              {t("more")}
            </Button>
          )}
        </>
      )}
    </Card>
  );
}

