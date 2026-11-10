"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { hasAny, rolesOf } from "@/components/access";
import { ErrorBlock, Modal, NoAccess, Notice, PageHead, Switch, TableSkeleton } from "@/components/kit";
import { Button, errorToast, Input, Pill, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { PLAN_LABEL, useFmt } from "../../workspaces/_parts/format";
import { AccountsDialog } from "./_parts/AccountsDialog";
import { CannedReplies } from "./_parts/Canned";
import { RuleDrawer } from "./_parts/RuleDrawer";
import { type Agent, type Config, type Dur, GROUPS, type Group, PLANS, PRIORITY_TONE, type Rule, SETTINGS_KEY, type SettingsView, TARGET_TONE } from "./_parts/types";

type AgentDraft = Record<string, { groups: Group[]; cap: number | null }>;
const agentDraft = (agents: Agent[]): AgentDraft => Object.fromEntries(agents.map((a) => [a.staffId, { groups: a.groups, cap: a.cap }]));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** ตั้งค่าการแจกงาน Support (Canvas › SupportSettings · เฟส 2 · O22) · Support ดูได้ แก้ได้เฉพาะ Owner */
export function SupportSettingsPage() {
  const t = useTranslations("sset");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const me = useMe().data;
  const read = hasAny(me, "owner", "support");
  const q = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api.get<SettingsView>("/support/settings"), enabled: !!me && read });
  const [config, setConfig] = useState<Config | null>(null);
  const [agents, setAgents] = useState<AgentDraft>({});
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<{ rule: Rule; n: number } | null>(null);
  const [accountsOf, setAccountsOf] = useState<Agent | null>(null);
  const data = q.data;
  const reset = () => data && (setConfig(structuredClone(data.config)), setAgents(agentDraft(data.agents)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reset, [data]);
  const edit = !!data?.canEdit;
  const dirty = useMemo(() => !!data && !!config && (!same(config, data.config) || !same(agents, agentDraft(data.agents))), [data, config, agents]);
  const invalid = !!config?.hours.some((h) => h.open && h.to <= h.from);

  const save = useMutation({
    mutationFn: () => api.put<{ saved: boolean }>("/support/settings", { config, agents: Object.entries(agents).map(([staffId, a]) => ({ staffId, ...a })) }),
    onSuccess: (r) => (toast(r.saved ? t("saved") : t("nothing")), void cache.invalidateQueries({ queryKey: ["ops", "support"] })),
    onError: (e) => toast(errorToast(e)),
  });
  const ruleMut = useMutation({
    mutationFn: (a: { kind: "toggle"; rule: Rule } | { kind: "move"; ids: string[] } | { kind: "delete"; rule: Rule }) =>
      a.kind === "toggle" ? api.patch(`/support/rules/${a.rule.id}`, { enabled: !a.rule.enabled }) : a.kind === "move" ? api.post("/support/rules/reorder", { ids: a.ids }) : api.delete(`/support/rules/${a.rule.id}`),
    onSuccess: (_r, a) => (a.kind === "delete" && (toast(t("rules.deleted")), setDeleting(null)), void cache.invalidateQueries({ queryKey: SETTINGS_KEY })),
    onError: (e) => toast(errorToast(e)),
  });

  if (me && !read) return <NoAccess need={["owner", "support"]} mine={rolesOf(me)} />;
  const set = <K extends keyof Config>(k: K, v: Config[K]) => setConfig((c) => (c ? { ...c, [k]: v } : c));
  const move = (i: number, d: -1 | 1) => {
    const ids = data!.rules.map((r) => r.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    ruleMut.mutate({ kind: "move", ids });
  };

  return (
    <>
      <PageHead
        title={t("title")}
        desc={data?.updatedBy && data.updatedAt ? `${t("desc")} · ${t("updated", { when: fmt.dateTime(data.updatedAt), by: data.updatedBy })}` : t("desc")}
        actions={
          edit && (
            <>
              <Button disabled={!dirty || save.isPending} onClick={reset}>
                {t("cancel")}
              </Button>
              <Button variant="primary" disabled={!dirty || invalid || save.isPending} onClick={() => save.mutate()}>
                {t("save")}
              </Button>
            </>
          )
        }
      />
      {q.isPending || !config || !data ? (
        q.error ? (
          <ErrorBlock error={q.error} retry={() => void q.refetch()} />
        ) : (
          <section className="card">
            <TableSkeleton rows={6} cols={4} />
          </section>
        )
      ) : (
        <div className="stack">
          {!edit && <Notice tone="info" title={t("readOnly")} />}
          {edit && dirty && <Notice tone="warn" title={t("unsaved")} />}

          <section className="card" aria-labelledby="sset-mode">
            <h2 className="card-title" id="sset-mode">
              {t("mode.title")}
            </h2>
            <div className="opt-grid" role="radiogroup" aria-labelledby="sset-mode">
              {(["least", "round", "manual"] as const).map((m) => (
                <label key={m} className={config.mode === m ? "opt opt-on" : "opt"}>
                  <input type="radio" name="sset-mode" checked={config.mode === m} disabled={!edit} onChange={() => set("mode", m)} />
                  <span>
                    <b>{t(`mode.${m}`)}</b>
                    <span className="cell-sub">{t(`mode.${m}Text`)}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="setting-rows">
              <div className="setting-row">
                <label htmlFor="sset-cap">{t("mode.cap")}</label>
                <input id="sset-cap" className="input input-cell" type="number" min={1} max={99} disabled={!edit} value={config.defaultCap} onChange={(e) => set("defaultCap", clamp(e.target.value, 1, 99))} />
                <span className="muted">{t("mode.capUnit")}</span>
              </div>
              <div className="setting-row">
                <Switch checked={config.skipUnavailable} disabled={!edit} label={t("mode.skip")} onChange={(v) => set("skipUnavailable", v)} />
                <span>{t("mode.skip")}</span>
              </div>
              <div className="setting-row">
                <label htmlFor="sset-reopen">{t("mode.reopen")}</label>
                <input id="sset-reopen" className="input input-cell" type="number" min={1} max={30} disabled={!edit} value={config.reopenDays} onChange={(e) => set("reopenDays", clamp(e.target.value, 1, 30))} />
                <span className="muted">{t("mode.reopenUnit")}</span>
              </div>
              <div className="setting-row">
                <label htmlFor="sset-away">{t("mode.away")}</label>
                <select id="sset-away" className="input select-inline" disabled={!edit} value={config.onAway} onChange={(e) => set("onAway", e.target.value as Config["onAway"])}>
                  <option value="queue">{t("mode.awayQueue")}</option>
                  <option value="ask_lead">{t("mode.awayLead")}</option>
                  <option value="keep">{t("mode.awayKeep")}</option>
                </select>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2 className="card-title">{t("rules.title")}</h2>
                <span className="card-sub">{t("rules.sub")}</span>
              </div>
              {edit && (
                <Button className="push-end" onClick={() => setAdding(true)}>
                  <Plus size={16} /> {t("rules.add")}
                </Button>
              )}
            </div>
            {!data.rules.length ? (
              <p className="muted">{t("rules.empty")}</p>
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th scope="col">{t("rules.col.n")}</th>
                      <th scope="col">{t("rules.col.when")}</th>
                      <th scope="col">{t("rules.col.group")}</th>
                      <th scope="col">{t("rules.col.prio")}</th>
                      <th scope="col">{t("rules.col.on")}</th>
                      {edit && (
                        <th scope="col">
                          <span className="sr-only">{t("rules.col.actions")}</span>
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rules.map((r, i) => (
                      <tr key={r.id} className={r.enabled ? undefined : "row-off"}>
                        <td className="num muted">{i + 1}</td>
                        <td className="cell-wrap">
                          <RuleWhen rule={r} />
                        </td>
                        <td>
                          <Pill tone={TARGET_TONE[r.target]}>{t(`target.${r.target}`)}</Pill>
                        </td>
                        <td>
                          <Pill tone={PRIORITY_TONE[r.priority]}>{t(`priority.${r.priority}`)}</Pill>
                        </td>
                        <td>
                          <Switch checked={r.enabled} disabled={!edit || ruleMut.isPending} label={t("rules.toggle", { n: i + 1 })} onChange={() => ruleMut.mutate({ kind: "toggle", rule: r })} />
                        </td>
                        {edit && (
                          <td>
                            <div className="row nowrap">
                              <Button size="icon" aria-label={t("rules.up", { n: i + 1 })} disabled={i === 0 || ruleMut.isPending} onClick={() => move(i, -1)}>
                                <ArrowUp size={16} />
                              </Button>
                              <Button size="icon" aria-label={t("rules.down", { n: i + 1 })} disabled={i === data.rules.length - 1 || ruleMut.isPending} onClick={() => move(i, 1)}>
                                <ArrowDown size={16} />
                              </Button>
                              <Button size="icon" aria-label={t("rules.delete", { n: i + 1 })} onClick={() => setDeleting({ rule: r, n: i + 1 })}>
                                <Trash2 size={16} />
                              </Button>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="grid-sla">
            <section className="card">
              <h2 className="card-title">{t("sla.title")}</h2>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th scope="col">{t("sla.col.plan")}</th>
                      <th scope="col">{t("sla.col.first")}</th>
                      <th scope="col">{t("sla.col.resolve")}</th>
                      <th scope="col">{t("sla.col.channel")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {PLANS.map((p) => (
                      <tr key={p}>
                        <td className="cell-strong">{PLAN_LABEL[p]}</td>
                        {(["first", "resolve"] as const).map((w) => (
                          <td key={w}>
                            <DurInput
                              value={config.sla[p][w]}
                              disabled={!edit}
                              label={(k) => t(`sla.${k}`, { plan: PLAN_LABEL[p], what: t(`sla.col.${w}`) })}
                              onChange={(v) => set("sla", { ...config.sla, [p]: { ...config.sla[p], [w]: v } })}
                            />
                          </td>
                        ))}
                        <td className="muted small cell-note">{t(`sla.channel.${p}`)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted small">
                {t("sla.note1", { pct: data.warnPct })}
                <br />
                {t("sla.note2")}
              </p>
            </section>

            <section className="card">
              <h2 className="card-title">{t("hours.title")}</h2>
              <div className="setting-rows">
                {(t.raw("hours.days") as string[]).map((day, i) => {
                  const h = config.hours[i];
                  const put = (v: Partial<typeof h>) => set("hours", config.hours.map((x, j) => (j === i ? { ...x, ...v } : x)));
                  return (
                    <div key={day} className="setting-row">
                      <span className="day-name">{day}</span>
                      <Switch checked={h.open} disabled={!edit} label={t("hours.open", { day })} onChange={(open) => put({ open })} />
                      {h.open ? (
                        <>
                          <input className="input input-time" type="time" aria-label={t("hours.from", { day })} disabled={!edit} value={h.from} onChange={(e) => put({ from: e.target.value })} />
                          <span className="muted">–</span>
                          <input className="input input-time" type="time" aria-label={t("hours.to", { day })} disabled={!edit} value={h.to} aria-invalid={h.to <= h.from} onChange={(e) => put({ to: e.target.value })} />
                        </>
                      ) : (
                        <span className="muted">{t("hours.closed")}</span>
                      )}
                    </div>
                  );
                })}
                <div className="setting-row">
                  <Switch checked={config.thaiHolidays} disabled={!edit} label={t("hours.holidays")} onChange={(v) => set("thaiHolidays", v)} />
                  <span>{t("hours.holidays")}</span>
                </div>
              </div>
              <p className="muted small">
                {data.holidays.upcoming.length ? t("hours.upcoming", { list: data.holidays.upcoming.map((h) => `${fmt.date(h.date)} ${h.name}`).join(" · ") }) : t("hours.noHolidays")}
                <br />
                {t("hours.holidaysNote")}
              </p>
            </section>
          </div>

          <section className="card">
            <div className="card-head">
              <div>
                <h2 className="card-title">{t("agents.title")}</h2>
                <span className="card-sub">{t("agents.sub")}</span>
              </div>
            </div>
            {!data.agents.length ? (
              <p className="muted">{t("agents.empty")}</p>
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th scope="col">{t("agents.col.name")}</th>
                      {GROUPS.map((g) => (
                        <th key={g} scope="col" className="center">
                          {t(`target.${g}`)}
                        </th>
                      ))}
                      <th scope="col">{t("agents.col.cap")}</th>
                      <th scope="col">{t("agents.col.accounts")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.agents.map((a) => {
                      const d = agents[a.staffId] ?? { groups: a.groups, cap: a.cap };
                      const put = (v: Partial<typeof d>) => setAgents((s) => ({ ...s, [a.staffId]: { ...d, ...v } }));
                      return (
                        <tr key={a.staffId}>
                          <td>
                            <div className="cell-strong">{a.name}</div>
                            <div className="cell-sub">{t("agents.load", { n: a.load })}</div>
                          </td>
                          {GROUPS.map((g) => (
                            <td key={g} className="center">
                              <input
                                type="checkbox"
                                className="check-cell"
                                aria-label={t("agents.inGroup", { name: a.name, group: t(`target.${g}`) })}
                                disabled={!edit}
                                checked={d.groups.includes(g)}
                                onChange={(e) => put({ groups: e.target.checked ? [...d.groups, g] : d.groups.filter((x) => x !== g) })}
                              />
                            </td>
                          ))}
                          <td>
                            <input
                              className="input input-cell"
                              type="number"
                              min={1}
                              max={99}
                              aria-label={t("agents.cap", { name: a.name })}
                              placeholder={String(config.defaultCap)}
                              title={t("agents.capDefault", { n: config.defaultCap })}
                              disabled={!edit}
                              value={d.cap ?? ""}
                              onChange={(e) => put({ cap: e.target.value === "" ? null : clamp(e.target.value, 1, 99) })}
                            />
                          </td>
                          <td>
                            <div className="row nowrap">
                              <span className={a.accounts.length ? undefined : "muted"}>{a.accounts.map((w) => w.name).join(", ") || "—"}</span>
                              {edit && (
                                <Button size="icon" aria-label={t("agents.editAccounts", { name: a.name })} onClick={() => setAccountsOf(a)}>
                                  <Pencil size={14} />
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <CannedReplies canEdit={edit} />
        </div>
      )}
      {adding && <RuleDrawer onClose={() => setAdding(false)} />}
      {accountsOf && <AccountsDialog agent={accountsOf} onClose={() => setAccountsOf(null)} />}
      {deleting && (
        <Modal open onOpenChange={(o) => !o && setDeleting(null)} title={t("rules.deleteTitle", { n: deleting.n })} description={t("rules.deleteDesc")}>
          <div className="dialog-body">
            <p>
              <RuleWhen rule={deleting.rule} />
            </p>
            <div className="dialog-actions">
              <Button onClick={() => setDeleting(null)}>{t("cancel")}</Button>
              <Button variant="danger" disabled={ruleMut.isPending} onClick={() => ruleMut.mutate({ kind: "delete", rule: deleting.rule })}>
                {t("rules.delete", { n: deleting.n })}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

const clamp = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(v) || min)));

/** "ถ้า" ของกฎ เป็นภาษาคน */
export function RuleWhen({ rule }: { rule: Pick<Rule, "plans" | "categories"> }) {
  const t = useTranslations("sset");
  const parts = [
    rule.plans.length ? t("rules.plan", { plans: rule.plans.map((p) => PLAN_LABEL[p]).join(", ") }) : "",
    rule.categories.length ? t("rules.category", { list: rule.categories.map((c) => t(`category.${c}`)).join(", ") }) : "",
  ].filter(Boolean);
  return <>{parts.join(t("rules.and")) || t("rules.else")}</>;
}

/** ระยะ SLA: จำนวน + หน่วย (ชม. ทำการ / วันทำการ / ไม่กำหนด) */
function DurInput({ value, onChange, disabled, label }: { value: Dur | null; onChange: (v: Dur | null) => void; disabled: boolean; label: (k: "n" | "unit") => string }) {
  const t = useTranslations("sset.sla");
  return (
    <div className="row nowrap">
      {value && <input className="input input-cell input-narrow" type="number" min={1} max={999} aria-label={label("n")} disabled={disabled} value={value.n} onChange={(e) => onChange({ ...value, n: clamp(e.target.value, 1, 999) })} />}
      <select className="input select-inline" aria-label={label("unit")} disabled={disabled} value={value?.unit ?? "none"} onChange={(e) => onChange(e.target.value === "none" ? null : { n: value?.n ?? 1, unit: e.target.value as Dur["unit"] })}>
        <option value="h">{t("h")}</option>
        <option value="d">{t("d")}</option>
        <option value="none">{t("none")}</option>
      </select>
    </div>
  );
}
