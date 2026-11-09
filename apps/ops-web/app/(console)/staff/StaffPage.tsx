"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ShieldAlert, UserPlus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { hasAny, initials } from "@/components/access";
import { ExportDialog } from "@/components/dialogs";
import { Chip, Empty, ErrorBlock, Notice, PageHead, RoleChips, TableSkeleton, Tabs } from "@/components/kit";
import { BreakGlassDialog } from "@/components/shell/BreakGlass";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import type { OpsRole } from "@/lib/types";
import { InviteDrawer, ManageDrawer } from "./StaffDrawers";
import { type AuditRow, DEFAULT_LIMITS, staffKey, type StaffList, type StaffMember } from "./types";

const STATUS_TONE: Record<StaffMember["status"], string> = { active: "pill ok", invited: "pill warn", suspended: "pill", disabled: "pill bad" };
const CATEGORIES = { workspace: "ops.", support: "support.", billing: "billing.", system: "system.", staff: "staff.", privacy: "privacy.", approval: "approval." } as const;

/** หน้า 8 · พนักงาน สิทธิ์ และ Audit log (Staff.dc.html) · Owner จัดการ · ผู้ตรวจอ่านอย่างเดียว */
export function StaffPage() {
  const t = useTranslations("staff");
  const params = useSearchParams();
  const router = useRouter();
  const tab = params?.get("tab") === "audit" ? "audit" : "staff";
  return (
    <>
      <PageHead title={t("title")} desc={t("desc")} />
      <Tabs
        label={t("title")}
        value={tab}
        onChange={(v) => router.replace(v === "audit" ? "/staff?tab=audit" : "/staff")}
        tabs={[
          { value: "staff", label: t("tabs.staff") },
          { value: "audit", label: t("tabs.audit") },
        ]}
      />
      {tab === "staff" ? <StaffTab /> : <AuditTab initialStaff={params?.get("staff") ?? ""} />}
    </>
  );
}

function StaffTab() {
  const t = useTranslations("staff");
  const tc = useTranslations("common");
  const format = useFormatter();
  const me = useMe().data;
  const owner = hasAny(me, "owner") && (me?.roles ?? []).includes("owner");
  const list = useQuery({ queryKey: staffKey, queryFn: () => api.get<StaffList>("/staff") });
  const [invite, setInvite] = useState<OpsRole[] | null>(null);
  const [manage, setManage] = useState<StaffMember | null>(null);
  const [glass, setGlass] = useState(false);
  const money = (s: number) => format.number(s / 100, { style: "currency", currency: "THB", maximumFractionDigits: 0 });
  const ownersLeft = list.data?.items.filter((s) => s.roles.includes("owner") && s.status === "active").length ?? 0;
  const departments = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of list.data?.items ?? []) if (s.status !== "disabled") m.set(s.department ?? "", (m.get(s.department ?? "") ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [list.data]);
  const lastUsed = (s: StaffMember) => {
    const ts = s.keys.map((k) => k.lastUsedAt).filter(Boolean) as string[];
    return ts.length ? format.relativeTime(new Date(ts.sort().pop()!)) : t("never");
  };
  const managed = manage ? (list.data?.items.find((s) => s.id === manage.id) ?? manage) : null;

  return (
    <>
      {owner && (
        <div className="page-actions">
          <Button variant="primary" onClick={() => setInvite(["support"])}>
            <UserPlus size={16} /> {t("invite")}
          </Button>
        </div>
      )}
      {list.data?.singleApprover && (
        <Notice tone="warn" icon={<ShieldAlert size={18} />} title={t("single.title")} action={owner ? <Button onClick={() => setInvite(["owner"])}>{t("single.add")}</Button> : undefined}>
          {t("single.desc")}
        </Notice>
      )}
      {list.isPending ? (
        <TableSkeleton rows={4} cols={7} />
      ) : list.error ? (
        <ErrorBlock error={list.error} retry={() => void list.refetch()} />
      ) : !list.data.items.length ? (
        <Empty title={t("audit.empty")} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("col.staff")}</th>
                <th>{t("col.roles")}</th>
                <th>{t("col.department")}</th>
                <th>{t("col.limits")}</th>
                <th>{t("col.keys")}</th>
                <th>{t("col.lastUsed")}</th>
                <th>{t("col.status")}</th>
                {owner && <th>{t("col.actions")}</th>}
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span className="row" style={{ flexWrap: "nowrap" }}>
                      <span className="avatar avatar-sm" aria-hidden="true">
                        {initials(s.name)}
                      </span>
                      <span>
                        <div className="cell-main">{s.name}</div>
                        <div className="cell-sub">{s.email}</div>
                      </span>
                    </span>
                  </td>
                  <td>
                    <RoleChips roles={s.roles} elevated={s.elevations.map((e) => e.role)} />
                  </td>
                  <td>{s.department ?? <span className="muted">{t("depts.none")}</span>}</td>
                  <td className="small">{s.roles.some((r) => r === "finance" || r === "owner") ? t("limitsShort", { refund: money(s.limits.refundSatang), pct: s.limits.discountPct }) : t("noMoney")}</td>
                  <td>{s.keys.length ? t("keysCount", { count: s.keys.length }) : <span className="pill warn">{t("noKeys")}</span>}</td>
                  <td className="small">{lastUsed(s)}</td>
                  <td>
                    <span className={STATUS_TONE[s.status]}>{t(`status.${s.status}`)}</span>
                    {s.expiresAt && <div className="cell-sub">{t("status.expires", { date: format.dateTime(new Date(s.expiresAt), { dateStyle: "medium" }) })}</div>}
                  </td>
                  {owner && (
                    <td>
                      <Button size="small" onClick={() => setManage(s)}>
                        {t("manage")}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid-2">
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">{t("matrix.title")}</h2>
            <span className="card-sub">{t("matrix.desc")}</span>
          </div>
          <table className="tbl">
            <tbody>
              {(["owner", "finance", "support", "engineer", "auditor"] as OpsRole[]).map((r) => (
                <tr key={r}>
                  <td className="cell-main">{tc(`roles.${r}`)}</td>
                  <td className="small">{tc(`roleDesc.${r}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">{t("defaults.title")}</h2>
            <span className="card-sub">{t("defaults.desc")}</span>
          </div>
          <table className="tbl">
            <tbody>
              <tr>
                <td>{t("defaults.refund")}</td>
                <td className="num">≤ {money(DEFAULT_LIMITS.refundSatang)}</td>
              </tr>
              <tr>
                <td>{t("defaults.credit")}</td>
                <td className="num">≤ {money(DEFAULT_LIMITS.creditSatang)}</td>
              </tr>
              <tr>
                <td>{t("defaults.discount")}</td>
                <td className="num">{t("defaults.discountValue", { pct: DEFAULT_LIMITS.discountPct, cycles: DEFAULT_LIMITS.discountCycles })}</td>
              </tr>
              <tr>
                <td>{t("defaults.trial")}</td>
                <td className="num">{t("defaults.trialValue", { days: DEFAULT_LIMITS.trialDays, times: DEFAULT_LIMITS.trialTimes })}</td>
              </tr>
              <tr>
                <td className="small">{t("defaults.always")}</td>
                <td className="num">
                  <span className="pill warn">{t("defaults.alwaysValue")}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">{t("glass.title")}</h2>
          </div>
          <p className="muted small">{t("glass.desc")}</p>
          {owner && (
            <div>
              <Button variant="danger" onClick={() => setGlass(true)}>
                {t("glass.open")}
              </Button>
            </div>
          )}
        </section>
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">{t("depts.title")}</h2>
            <span className="card-sub">{t("depts.desc")}</span>
          </div>
          <div className="row">
            {departments.map(([d, n]) => (
              <span key={d || "none"} className="pill">
                {d || t("depts.none")} · {t("depts.people", { count: n })}
              </span>
            ))}
          </div>
        </section>
      </div>

      <InviteDrawer key={invite?.join() ?? "closed"} open={!!invite} onOpenChange={(o) => !o && setInvite(null)} initialRoles={invite ?? ["support"]} />
      <ManageDrawer key={managed?.id ?? "none"} member={managed} onOpenChange={(o) => !o && setManage(null)} ownersLeft={ownersLeft} />
      {me && <BreakGlassDialog staff={me} open={glass} onOpenChange={setGlass} />}
    </>
  );
}

function AuditTab({ initialStaff }: { initialStaff: string }) {
  const t = useTranslations("staff.audit");
  const tc = useTranslations("common");
  const format = useFormatter();
  const staff = useQuery({ queryKey: staffKey, queryFn: () => api.get<StaffList>("/staff") });
  const [who, setWho] = useState(initialStaff);
  const [cat, setCat] = useState<keyof typeof CATEGORIES | "">("");
  const [selfOnly, setSelfOnly] = useState(false);
  const [exporting, setExporting] = useState(false);
  const filter = new URLSearchParams({ limit: "50", ...(who ? { staffId: who } : {}), ...(cat ? { action: CATEGORIES[cat] } : {}), ...(selfOnly ? { selfApproved: "true" } : {}) });
  const log = useInfiniteQuery({
    queryKey: ["ops", "audit", filter.toString()],
    queryFn: ({ pageParam }) => api.get<{ items: AuditRow[] }>(`/audit?${filter}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (last) => (last.items.length === 50 ? last.items[last.items.length - 1].createdAt : undefined),
  });
  const rows = log.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = !!(who || cat || selfOnly);
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{t("title")}</h2>
        <span className="card-sub">{t("desc")}</span>
        <span className="spacer" />
        <Button size="small" disabled={!rows.length} onClick={() => setExporting(true)}>
          {t("export")}
        </Button>
      </div>
      <div className="row">
        <select className="input" style={{ width: "auto" }} aria-label={t("col.staff")} value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">{t("everyone")}</option>
          {staff.data?.items.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select className="input" style={{ width: "auto" }} aria-label={t("category")} value={cat} onChange={(e) => setCat(e.target.value as typeof cat)}>
          <option value="">{t("all")}</option>
          {(Object.keys(CATEGORIES) as (keyof typeof CATEGORIES)[]).map((c) => (
            <option key={c} value={c}>
              {t(`cat.${c}`)}
            </option>
          ))}
        </select>
        <Chip pressed={selfOnly} onClick={() => setSelfOnly(!selfOnly)}>
          {t("selfOnly")}
        </Chip>
      </div>
      {log.isPending ? (
        <TableSkeleton rows={5} cols={5} />
      ) : log.error ? (
        <ErrorBlock error={log.error} retry={() => void log.refetch()} />
      ) : !rows.length ? (
        <Empty title={filtered ? tc("state.emptyFiltered") : t("empty")} onClearFilters={filtered ? () => (setWho(""), setCat(""), setSelfOnly(false)) : undefined} />
      ) : (
        <>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("col.time")}</th>
                  <th>{t("col.staff")}</th>
                  <th>{t("col.action")}</th>
                  <th>{t("col.reason")}</th>
                  <th>{t("col.roles")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="small" style={{ whiteSpace: "nowrap" }}>
                      {format.dateTime(new Date(r.createdAt), { dateStyle: "medium", timeStyle: "short" })}
                    </td>
                    <td>{r.staffName}</td>
                    <td>
                      <code className="mono small">{r.action}</code> {r.selfApproved && <span className="pill warn">{t("selfTag")}</span>}
                    </td>
                    <td className="small">{r.reason}</td>
                    <td className="small">{r.roles.map((x) => tc(`roles.${x}`)).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {log.hasNextPage && (
            <Button disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
              {t("more")}
            </Button>
          )}
        </>
      )}
      <ExportDialog
        open={exporting}
        onOpenChange={setExporting}
        title={t("export")}
        filename="friday-ops-audit.csv"
        rows={rows.map((r) => ({ ...r, roles: r.roles.join(" ") }))}
        columns={[
          { key: "createdAt", label: t("col.time") },
          { key: "staffName", label: t("col.staff") },
          { key: "action", label: t("col.action") },
          { key: "reason", label: t("col.reason") },
          { key: "roles", label: t("col.roles") },
          { key: "ip", label: "IP", pii: true },
        ]}
      />
    </section>
  );
}
