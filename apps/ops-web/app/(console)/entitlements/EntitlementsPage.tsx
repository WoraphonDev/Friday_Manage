"use client";

import { useQuery } from "@tanstack/react-query";
import { History, Pencil } from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment, useMemo, useState } from "react";
import { hasAny, rolesOf } from "@/components/access";
import { ErrorBlock, NoAccess, Notice, PageHead, Switch, TableSkeleton } from "@/components/kit";
import { Button, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useFmt } from "../workspaces/_parts/format";
import { HistoryDrawer } from "./_parts/History";
import { NearLimit } from "./_parts/NearLimit";
import { Overrides } from "./_parts/Overrides";
import { SaveVersion } from "./_parts/SaveVersion";
import { type Matrix, type Overview, PLAN_NAME, PLANS, type PlanCode, useShow, type Value } from "./_parts/types";

export const ENT_KEY = ["ops", "entitlements"] as const;

/** หน้า Entitlements (Canvas › สิทธิ์และขีดจำกัด · เฟส 2 · O21) */
export function EntitlementsPage() {
  const t = useTranslations("ent");
  const fmt = useFmt();
  const me = useMe().data;
  const read = hasAny(me, "owner", "finance", "engineer");
  const editor = hasAny(me, "owner", "finance");
  const q = useQuery({ queryKey: ENT_KEY, queryFn: () => api.get<Overview>("/entitlements"), enabled: !!me && read });
  const [draft, setDraft] = useState<Matrix | null>(null);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState(false);
  const changed = useMemo(() => {
    if (!draft || !q.data) return 0;
    return PLANS.reduce((n, p) => n + q.data.keys.filter((k) => draft[p][k.key] !== q.data.current.matrix[p][k.key]).length, 0);
  }, [draft, q.data]);
  if (me && !read) return <NoAccess need={["owner", "finance", "engineer"]} mine={rolesOf(me)} />;
  const data = q.data;
  return (
    <>
      <PageHead
        title={t("title")}
        desc={t("desc")}
        actions={
          <>
            <Button onClick={() => setHistory(true)}>
              <History size={16} /> {t("history")}
            </Button>
            {editor &&
              data &&
              (draft ? (
                <>
                  <Button onClick={() => setDraft(null)}>{t("cancelEdit")}</Button>
                  <Button variant="primary" disabled={!changed} onClick={() => setSaving(true)}>
                    {t("saveVersion")}
                    {changed > 0 && ` · ${t("changedCount", { count: changed })}`}
                  </Button>
                </>
              ) : (
                <Button variant="primary" onClick={() => setDraft(structuredClone(data.current.matrix))}>
                  <Pencil size={16} /> {t("edit")}
                </Button>
              ))}
          </>
        }
      />
      {data?.pending.length ? (
        <Notice tone="warn" title={t("pendingTitle", { count: data.pending.length })}>
          {data.pending.map((p) => (
            <div key={p.id} className="small">
              {t("pendingItem", { name: p.requestedBy, time: fmt.dateTime(p.createdAt), reason: p.reason })}
            </div>
          ))}
        </Notice>
      ) : null}
      {data?.scheduled.map((s) => (
        <Notice key={s.version} tone="info" title={t("scheduledTitle", { version: s.version, date: fmt.dateTime(s.effectiveAt) })}>
          {s.reason}
        </Notice>
      ))}
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t("matrix.title")}</h2>
          {data && <Pill>{data.current.version ? t("matrix.version", { version: data.current.version, date: fmt.date(data.current.effectiveAt) }) : t("matrix.default")}</Pill>}
          <span className="card-sub">{draft ? t("matrix.editHint") : t("matrix.note")}</span>
        </div>
        {q.isPending ? (
          <TableSkeleton rows={8} cols={6} />
        ) : q.error ? (
          <ErrorBlock error={q.error} retry={() => void q.refetch()} />
        ) : (
          <MatrixTable data={q.data} draft={draft} onChange={setDraft} />
        )}
      </section>
      {data && <Overrides data={data} />}
      {data && <NearLimit items={data.nearLimit} />}
      {saving && draft && data && (
        <SaveVersion
          draft={draft}
          current={data.current.matrix}
          keys={data.keys}
          onClose={() => setSaving(false)}
          onSent={() => {
            setSaving(false);
            setDraft(null);
          }}
        />
      )}
      <HistoryDrawer open={history} onOpenChange={setHistory} canRestore={editor} keys={data?.keys ?? []} />
    </>
  );
}

function MatrixTable({ data, draft, onChange }: { data: Overview; draft: Matrix | null; onChange: (m: Matrix) => void }) {
  const t = useTranslations("ent");
  const show = useShow();
  const set = (plan: PlanCode, key: string, v: Value) => draft && onChange({ ...draft, [plan]: { ...draft[plan], [key]: v } });
  const groups = [
    { label: t("matrix.limits"), keys: data.keys.filter((k) => k.kind === "limit") },
    { label: t("matrix.features"), keys: data.keys.filter((k) => k.kind === "feature") },
  ];
  return (
    <div className="tbl-wrap">
      <table className="tbl tbl-matrix">
        <thead>
          <tr>
            <th scope="col">{t("matrix.feature")}</th>
            {data.plans.map((p) => (
              <th key={p.code} scope="col" className="num">
                {PLAN_NAME[p.code]}
                <div className="cell-sub">{t("matrix.customers", { count: p.customers })}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.label}>
              <tr className="tbl-group">
                <td colSpan={PLANS.length + 1}>{g.label}</td>
              </tr>
              {g.keys.map((k) => {
                const label = t(`keys.${k.key}` as "keys.seats");
                return (
                  <tr key={k.key}>
                    <th scope="row" className="tbl-rowhead">
                      <span className="cell-main">{label}</span> <span className="mono muted small">{k.key}</span>
                      {!k.enforced && (
                        <div className="cell-sub" title={t("matrix.notEnforcedHint")}>
                          {t("matrix.notEnforced")}
                        </div>
                      )}
                    </th>
                    {PLANS.map((p) => {
                      const v = (draft ?? data.current.matrix)[p][k.key];
                      const dirty = !!draft && v !== data.current.matrix[p][k.key];
                      const name = `${label} · ${PLAN_NAME[p]}`;
                      if (draft) {
                        return (
                          <td key={p} className={dirty ? "num cell-dirty" : "num"}>
                            {k.kind === "feature" ? (
                              <Switch checked={v === true} onChange={(on) => set(p, k.key, on)} label={name} />
                            ) : (
                              <input
                                className="input input-cell"
                                inputMode="numeric"
                                aria-label={name}
                                placeholder={t("matrix.unlimited")}
                                value={v === null ? "" : String(v)}
                                onChange={(e) => {
                                  const raw = e.target.value.replace(/[^\d]/g, "");
                                  set(p, k.key, raw === "" ? null : Number(raw));
                                }}
                              />
                            )}
                          </td>
                        );
                      }
                      return (
                        <td key={p} className={typeof v === "boolean" ? (v ? "num cell-yes" : "num muted") : "num"}>
                          {show(k.key, v, { plan: p, unit: k.unit })}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
