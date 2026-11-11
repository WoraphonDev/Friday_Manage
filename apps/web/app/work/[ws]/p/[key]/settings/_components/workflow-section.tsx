"use client";

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Check } from "lucide-react";
import { Button, Dialog, EmptyState, ErrorState, Forbidden, Input, LoadingState, Select, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { SectionHead, projectEndpoint } from "./shared";
import { errorText, isForbidden, move, patchPlain, type Category, type ProjectDetail, type Status, type Workflow } from "./types";
import { phaseRuns, STATUS_CATEGORIES, STATUS_SWATCHES, statusColorStyle, statusDotColor, statusPhase, statusTone } from "@/lib/status";
import { queryKeys } from "@/lib/query";
import styles from "./settings.module.css";

const CATEGORIES: readonly Category[] = STATUS_CATEGORIES;

/** ชุดสถานะ Development + QA (ตรงกับ DEV_QA_FLOW ของ API) · ชื่อชุดนี้ใช้เฉพาะ Template นี้ */
export const DEV_QA_FLOW = [
  { key: "todo", name: "To do", category: "todo" },
  { key: "in_progress", name: "In progress", category: "in_progress" },
  { key: "rework", name: "Rework", category: "in_progress" },
  { key: "ready_for_qa", name: "Ready for QA", category: "review" },
  { key: "testing", name: "Testing", category: "review" },
  { key: "done", name: "Done", category: "done" },
  { key: "rejected", name: "Rejected", category: "cancelled" },
] as const satisfies readonly { key: string; name: string; category: Category }[];
export type DevQaKey = (typeof DEV_QA_FLOW)[number]["key"];

/** คู่ที่เสนอให้สถานะเดิม: ชื่อที่ตรงกันก่อน แล้วจึงดูตามหมวด (Blocked ไม่มีในชุดนี้ จึงไป In progress) */
export function suggestDevQa(s: Pick<Status, "name" | "category">): DevQaKey {
  const name = s.name.trim().toLowerCase();
  const byName = DEV_QA_FLOW.find((x) => x.name.toLowerCase() === name);
  if (byName) return byName.key;
  if (/rework|fix|แก้/.test(name)) return "rework";
  if (/test|ทดสอบ/.test(name)) return "testing";
  if (/reject|cancel|ยกเลิก/.test(name)) return "rejected";
  const byCategory: Record<Category, DevQaKey> = { todo: "todo", in_progress: "in_progress", blocked: "in_progress", review: "ready_for_qa", done: "done", cancelled: "rejected" };
  return byCategory[s.category];
}

/** ข้อความ "แสดงบน Kanban ในคอลัมน์" ของ Workflow Bug: จัดกลุ่มสถานะ Bug ตามคอลัมน์ของ Workflow มาตรฐาน */
export function bugColumns(bug: Workflow, standard: Workflow | undefined) {
  const columns = new Map<string, string[]>();
  for (const s of bug.statuses) {
    const column = standard?.statuses.find((x) => x.id === s.boardColumnId)?.name ?? s.name;
    columns.set(column, [...(columns.get(column) ?? []), s.name]);
  }
  return [...columns].map(([column, names]) => `${names.join(", ")} → ${column}`).join(" · ");
}

/** ป้ายสถานะ: สีที่ผู้ใช้เลือก ถ้าไม่มีใช้ class ตามหมวด (ชุดเดียวกับป้ายทั้งแอป) */
function StatusChip({ s }: { s: Pick<Status, "name" | "category" | "color"> }) {
  return <span className={`badge status-pill-${statusTone(s.category, s.name)} ${styles.chip}`} style={statusColorStyle(s.color)}>{s.name}</span>;
}

/** เลือกสีสถานะ: สีพื้นฐาน · สีตามหมวด (null) · หรือสีเอง */
function ColorPicker({ label, value, fallback, onChange }: { label: string; value: string | null; fallback: string; onChange: (color: string | null) => void }) {
  const t = useTranslations("project-settings-new.settings.workflow");
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className={styles.colorBtn} aria-label={label} style={{ background: value ?? fallback }} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={`popover ${styles.colorPop}`} sideOffset={6} align="start" aria-label={label}>
          <div className={styles.swatches}>
            {STATUS_SWATCHES.map((c) => (
              <Popover.Close asChild key={c}>
                <button type="button" className={styles.swatchBtn} style={{ background: c }} aria-label={c} aria-pressed={value?.toLowerCase() === c} onClick={() => onChange(c)}>
                  {value?.toLowerCase() === c && <Check size={12} strokeWidth={3} aria-hidden="true" />}
                </button>
              </Popover.Close>
            ))}
          </div>
          <Popover.Close asChild>
            <button type="button" className={styles.colorAuto} aria-pressed={!value} onClick={() => onChange(null)}>
              <span className={styles.swatch} style={{ background: fallback }} aria-hidden="true" />{t("colorAuto")}
            </button>
          </Popover.Close>
          <label className={styles.colorCustom}>
            <input type="color" value={value ?? "#5b3fc4"} onChange={(e) => onChange(e.target.value)} />
            {t("colorCustom")}
          </label>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function WorkflowSection({ ws, projectKey, project }: { ws: string; projectKey: string; project?: ProjectDetail }) {
  const t = useTranslations("project-settings-new.settings.workflow");
  const cache = useQueryClient();
  const toast = useToast();
  const base = projectEndpoint(ws, projectKey);
  const queryKey = ["workspace", ws, "project", projectKey, "settings", "workflows"];
  const workflows = useQuery({ queryKey, queryFn: () => api.get<{ items: Workflow[] }>(`${base}/workflows`) });
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState<Category>("in_progress");
  const [newColor, setNewColor] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Status | null>(null);
  const [moveTo, setMoveTo] = useState("");
  const [devQa, setDevQa] = useState<Record<string, DevQaKey> | null>(null);
  const [devQaSplit, setDevQaSplit] = useState(true);

  if (isForbidden(workflows.error)) return <Forbidden />;
  if (workflows.error) return <ErrorState error={workflows.error} retry={() => void workflows.refetch()} />;
  if (!workflows.data) return <LoadingState />;
  const items = workflows.data.items;
  if (!items.length) return <EmptyState />;
  const wf = items.find((w) => w.id === selected) ?? items[0];
  const wfBase = `${base}/workflows/${wf.id}`;
  // สีสถานะใช้ทั้งแอปผ่านข้อมูลโปรเจกต์ จึงโหลดข้อมูลโปรเจกต์ใหม่ด้วย
  const reload = () => Promise.all([cache.invalidateQueries({ queryKey }), cache.invalidateQueries({ queryKey: queryKeys.project(ws, projectKey) })]);

  async function run(action: () => Promise<unknown>, success?: string) {
    try {
      await action();
      if (success) toast({ message: success });
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    }
    await reload();
  }
  const patchStatus = (s: Status, body: Record<string, unknown>) => run(() => patchPlain(`${wfBase}/statuses/${s.id}`, body), t("saved"));
  const reorder = (index: number, delta: number) => run(() => api.post(`${wfBase}/statuses/reorder`, { ids: move(wf.statuses, index, delta).map((s) => s.id) }));
  async function toggleRule(ruleType: string, enabled: boolean) {
    // แถวกฎที่ไม่มี config = ใช้กับทุกสถานะ · ยังไม่มีแถวสร้างใหม่ (ค่าตอนนี้มาจากค่าเริ่มต้นของระบบ)
    const row = wf.rules.find((r) => r.ruleType === ruleType && !Object.keys(r.config ?? {}).length);
    await run(() => (row ? patchPlain(`${wfBase}/rules/${row.id}`, { enabled }) : api.post(`${wfBase}/rules`, { ruleType, enabled })), t("saved"));
  }
  async function add() {
    if (!newName.trim()) return;
    await run(() => api.post(`${wfBase}/statuses`, { name: newName.trim(), category: newCategory, color: newColor }), t("added"));
    setAdding(false);
    setNewName("");
    setNewColor(null);
  }
  async function remove() {
    if (!removing) return;
    const body = removing.issueCount ? { moveTo } : {};
    await run(() => api.delete(`${wfBase}/statuses/${removing.id}`, { body }), t("removed", { name: removing.name }));
    setRemoving(null);
  }
  async function toggleSplit(on: boolean) {
    if (!project) return;
    await run(() => api.patch(base, { progressSplit: on }, project.version), t("saved"));
    await cache.invalidateQueries({ queryKey: ["overview", ws, projectKey] });
  }
  function openDevQa() {
    setDevQa(Object.fromEntries(wf.statuses.map((s) => [s.id, suggestDevQa(s)])));
    setDevQaSplit(true);
  }
  async function applyDevQa() {
    if (!devQa) return;
    await run(() => api.post(`${wfBase}/apply-dev-qa`, { mapping: devQa, progressSplit: devQaSplit }), t("devQa.applied"));
    await cache.invalidateQueries({ queryKey: ["overview", ws, projectKey] });
    setDevQa(null);
  }
  const devQaCreated = devQa ? DEV_QA_FLOW.filter((x) => !Object.values(devQa).includes(x.key)) : [];
  const devQaMerged = devQa ? DEV_QA_FLOW.map((x) => wf.statuses.filter((s) => devQa[s.id] === x.key)).filter((list) => list.length > 1) : [];
  const devQaMoved = devQaMerged.reduce((n, list) => n + list.slice(1).reduce((m, s) => m + s.issueCount, 0), 0);
  // แยก Dev / QA: บอกช่วงของแต่ละสถานะ (คิดจากหมวด) เฉพาะ Workflow มาตรฐาน
  const phased = wf.kind === "standard" && !!project?.progressSplit;
  const PhasePill = ({ category }: { category: string }) => <span className={`${styles.phasePill} ${styles[`phase_${statusPhase(category)}`]}`}>{t(`phase.${statusPhase(category)}`)}</span>;
  const label = (w: Workflow) => w.issueTypes.map((x) => x.name).join(" / ") || w.name;
  const standard = items.find((w) => w.kind === "standard");

  return (
    <>
      <SectionHead title={t("title")} description={t("description")}>
        {items.length > 1 && (
          <div className={styles.seg} role="group" aria-label={t("typeGroup")}>
            {items.map((w) => (
              <Button key={w.id} size="small" aria-pressed={w.id === wf.id} onClick={() => setSelected(w.id)}>{label(w)}</Button>
            ))}
          </div>
        )}
      </SectionHead>
      <div className={styles.sb}>
        {wf.kind === "standard" && project && (
          <div className={styles.switchRow}>
            <button type="button" role="switch" className={styles.switch} aria-checked={project.progressSplit} aria-label={t("devQa.split")} onClick={() => void toggleSplit(!project.progressSplit)}>
              <span />
            </button>
            <div className={styles.devQaText}>
              <b>{t("devQa.split")}</b> <span className={styles.pill}>{project.progressSplit ? t("devQa.on") : t("devQa.off")}</span>
              <div className={styles.muted}>{t("devQa.splitHint")}</div>
            </div>
            <Button size="small" onClick={openDevQa}>{t("devQa.apply")}</Button>
          </div>
        )}
        {phased ? (
          <div className={styles.flow} aria-label={t("flowLabel")}>
            {phaseRuns(wf.statuses).map((run, r) => (
              <span key={`${run.phase}:${run.start}`} className={`${styles.flowGroup} ${styles[`phase_${run.phase}`]}`}>
                {r > 0 && <span className={styles.muted} aria-hidden="true">→</span>}
                <span className={styles.flowPhase}>{t(`phase.${run.phase}`)}</span>
                {run.items.map((s, i) => (
                  <span key={s.id} className={styles.flow}>
                    {i > 0 && <span className={styles.muted} aria-hidden="true">→</span>}
                    <StatusChip s={s} />
                  </span>
                ))}
              </span>
            ))}
          </div>
        ) : (
          <div className={styles.flow} aria-label={t("flowLabel")}>
            {wf.statuses.map((s, i) => (
              <span key={s.id} className={styles.flow}>
                {i > 0 && <span className={styles.muted} aria-hidden="true">→</span>}
                <StatusChip s={s} />
              </span>
            ))}
          </div>
        )}
        <div className={styles.list}>
          <div className={`${styles.rowHead} ${phased ? styles.phasedRow : ""}`} aria-hidden="true">
            <span />
            <span>{t("color")}</span>
            <span>{t("statusName")}</span>
            <span className={styles.hs}>{t("category")}</span>
            {phased && <span className={styles.hs}>{t("phase.title")}</span>}
            <span className={styles.hs}>{t("wip")}</span>
            <span className={styles.hs}>{t("used")}</span>
            <span />
          </div>
          {wf.statuses.map((s, i) => (
            <div key={`${s.id}:${s.name}:${s.wipLimit}`} className={`${styles.row} ${styles.statusRow} ${phased ? styles.phasedRow : ""}`} data-testid={`status-${s.name}`}>
              <span className={styles.order}>
                {/* Canvas: ที่จับ + สีสถานะ · ปุ่มเลื่อนขึ้น/ลงแสดงเมื่อชี้หรือโฟกัส (ใช้แทนการลากด้วยแป้นพิมพ์) */}
                <span className={styles.grip} aria-hidden="true">⋮⋮</span>
                <button type="button" className={`${styles.icon} ${styles.orderBtn}`} disabled={i === 0} aria-label={t("moveUp", { name: s.name })} onClick={() => void reorder(i, -1)}>↑</button>
                <button type="button" className={`${styles.icon} ${styles.orderBtn}`} disabled={i === wf.statuses.length - 1} aria-label={t("moveDown", { name: s.name })} onClick={() => void reorder(i, 1)}>↓</button>
              </span>
              <ColorPicker label={t("colorOf", { name: s.name })} value={s.color ?? null} fallback={statusDotColor(s.category, s.name)} onChange={(color) => void patchStatus(s, { color })} />
              <input
                className={styles.in}
                defaultValue={s.name}
                aria-label={t("statusNameOf", { name: s.name })}
                maxLength={60}
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== s.name) void patchStatus(s, { name: v }); }}
              />
              <select className={`${styles.in} ${styles.hs}`} value={s.category} aria-label={t("categoryOf", { name: s.name })} onChange={(e) => void patchStatus(s, { category: e.target.value })}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{t(`categories.${c}`)}</option>)}
              </select>
              {phased && <span className={styles.hs} aria-label={t("phase.of", { name: s.name, phase: t(`phase.${statusPhase(s.category)}`) })}><PhasePill category={s.category} /></span>}
              <input
                className={`${styles.in} ${styles.hs}`}
                type="number"
                min={1}
                max={999}
                defaultValue={s.wipLimit ?? ""}
                placeholder="—"
                aria-label={t("wipOf", { name: s.name })}
                onBlur={(e) => {
                  const v = e.target.value ? Number(e.target.value) : null;
                  if (v !== s.wipLimit) void patchStatus(s, { wipLimit: v });
                }}
              />
              <span className={`${styles.muted} ${styles.hs}`}>{t("issues", { count: s.issueCount })}</span>
              <button type="button" className={styles.x} aria-label={t("remove", { name: s.name })} onClick={() => { setRemoving(s); setMoveTo(wf.statuses.find((x) => x.id !== s.id)?.id ?? ""); }}>×</button>
            </div>
          ))}
          <div>
            <Button onClick={() => setAdding(true)}>{t("add")}</Button>
          </div>
          <div className={styles.note}>
            <b>{t("categoryGuide")}</b>
            <div className={styles.catGuide}>
              {CATEGORIES.map((c) => (
                <div key={c}>
                  <span className={`badge status-pill-${c}`}>{t(`categories.${c}`)}</span>
                  {phased && <PhasePill category={c} />}
                  <span className={styles.muted}>{t(`categoryHints.${c}`)}</span>
                </div>
              ))}
            </div>
            {phased && <span className={styles.muted}>{t("phase.hint")}</span>}
          </div>
          {wf.kind === "bug" && (
            <div className={styles.note}>
              <b>{t("bugColumnsTitle")}</b>
              <span>{bugColumns(wf, standard)}</span>
              <span className={styles.muted}>{t("bugColumnsHint")}</span>
            </div>
          )}
        </div>
        <div className={styles.fld}>
          <span className={styles.lb}>{t("rules")}</span>
          <div className={styles.rules}>
            {wf.catalog.map((r) => (
              <label key={r.ruleType}>
                <input type="checkbox" checked={r.enabled} onChange={(e) => void toggleRule(r.ruleType, e.target.checked)} />
                <span>
                  <b>{r.title}</b>
                  <span className={styles.muted}>{r.description}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className={styles.muted}>{t("footer")}</div>
      </div>

      <Dialog open={adding} onOpenChange={setAdding} title={t("addTitle")}>
        <form className={styles.dialogForm} onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <Input label={t("statusName")} value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={60} required />
          <Select label={t("category")} value={newCategory} hint={t(`categoryHints.${newCategory}`)} onChange={(e) => setNewCategory(e.target.value as Category)}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{t(`categories.${c}`)}</option>)}
          </Select>
          <div className={styles.fld}>
            <span className={styles.lb}>{t("color")}</span>
            <div className={styles.colorRow}>
              <ColorPicker label={t("color")} value={newColor} fallback={statusDotColor(newCategory, newName)} onChange={setNewColor} />
              <span className={styles.muted}>{t("preview")}</span>
              <StatusChip s={{ name: newName.trim() || t("statusName"), category: newCategory, color: newColor }} />
            </div>
          </div>
          <div className="dialog-actions">
            <Button onClick={() => setAdding(false)}>{t("cancel")}</Button>
            <Button type="submit" variant="primary" disabled={!newName.trim()}>{t("addConfirm")}</Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={!!devQa} onOpenChange={(o) => !o && setDevQa(null)} size="medium" title={t("devQa.applyTitle")} description={t("devQa.applyDescription")}>
        {devQa && (
          <div className={styles.dialogForm}>
            <div className={styles.devQaMap} role="table" aria-label={t("devQa.applyTitle")}>
              <div className={styles.devQaHead} role="row">
                <span role="columnheader">{t("devQa.oldStatus")}</span>
                <span role="columnheader">{t("used")}</span>
                <span role="columnheader">{t("devQa.newStatus")}</span>
              </div>
              {wf.statuses.map((s) => (
                <div key={s.id} className={styles.devQaRow} role="row">
                  <span role="cell"><StatusChip s={s} /></span>
                  <span role="cell" className={styles.muted}>{t("issues", { count: s.issueCount })}</span>
                  <span role="cell">
                    <select className={styles.in} aria-label={t("devQa.newStatusOf", { name: s.name })} value={devQa[s.id]} onChange={(e) => setDevQa({ ...devQa, [s.id]: e.target.value as DevQaKey })}>
                      {DEV_QA_FLOW.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}
                    </select>
                  </span>
                </div>
              ))}
            </div>
            <div className={styles.note}>
              <span>{t("devQa.created", { names: devQaCreated.map((x) => x.name).join(", ") || t("devQa.none") })}</span>
              {devQaMerged.map((list) => <span key={list[0].id}>{t("devQa.merged", { names: list.map((x) => x.name).join(", "), target: DEV_QA_FLOW.find((x) => x.key === devQa[list[0].id])!.name, count: list.slice(1).reduce((m, x) => m + x.issueCount, 0) })}</span>)}
              <span className={styles.muted}>{t("devQa.keepHistory")}</span>
            </div>
            <label className={styles.devQaCheck}><input type="checkbox" checked={devQaSplit} onChange={(e) => setDevQaSplit(e.target.checked)} /> {t("devQa.splitOnApply")}</label>
            <div className="dialog-actions">
              <Button onClick={() => setDevQa(null)}>{t("cancel")}</Button>
              <Button variant="primary" onClick={() => void applyDevQa()}>{devQaMoved ? t("devQa.confirmMove", { count: devQaMoved }) : t("devQa.confirm")}</Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} title={t("removeTitle", { name: removing?.name ?? "" })}>
        <div className={styles.dialogForm}>
          {removing?.issueCount ? (
            <>
              <p className={styles.muted}>{t("removeHasIssues", { count: removing.issueCount })}</p>
              <Select label={t("moveTo")} value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                {wf.statuses.filter((x) => x.id !== removing.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
            </>
          ) : (
            <p className={styles.muted}>{t("removeEmpty")}</p>
          )}
          <div className="dialog-actions">
            <Button onClick={() => setRemoving(null)}>{t("cancel")}</Button>
            <Button variant="danger" disabled={!!removing?.issueCount && !moveTo} onClick={() => void remove()}>{t("removeConfirm")}</Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
