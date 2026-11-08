"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Badge, Button, ErrorState, Forbidden, Input, LoadingState, Select } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api } from "@/lib/api";
import { formatDate, type YearFormat } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import type { List, Permissions, Project } from "@/lib/types";
import { ExportPanel } from "./export-panel";
import { ImportHeader } from "./import-header";
import { type CommitResult, type Finding, type ImportJob, type JobPerson, type Member, personKey } from "./types";
import { num, showValue } from "./values";
import styles from "./import.module.css";

type Step = 1 | 2 | 3 | 4;
type Mode = "create" | "update";
type Filter = "issue" | "err" | "warn";
const PAGE = 100;
const LEVEL = { err: { color: "#b91c1c", sym: "!" }, warn: { color: "#b45309", sym: "!" } } as const;
const CHIP: Record<Filter, string> = { issue: "#b45309", err: "#b91c1c", warn: "#b45309" };

const fmtSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export function ImportWizard({ ws }: { ws: string }) {
  const t = useTranslations("import-plan-changes.import");
  const { workspace, me } = useWorkspace();
  const year = me.yearFormat;
  const search = useSearchParams();
  const cache = useQueryClient();
  const w = `/w/${encodeURIComponent(ws)}`;
  const initialProject = search.get("project") ?? "";

  const [step, setStep] = useState<Step>(1);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(initialProject ? "update" : "create");
  const [target, setTarget] = useState(initialProject);
  const [job, setJob] = useState<ImportJob | null>(null);
  // ไฟล์ / โหมด / โปรเจกต์ที่ใช้สร้าง job ปัจจุบัน · เปลี่ยนอย่างใดอย่างหนึ่ง = อัปโหลดใหม่
  const [jobFor, setJobFor] = useState<{ file: File; mode: Mode; target: string } | null>(null);
  const [busy, setBusy] = useState<null | "upload" | "patch" | "commit">(null);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [section, setSection] = useState<"import" | "export">(search.get("section") === "export" ? "export" : "import");

  const projects = useQuery({ queryKey: queryKeys.projects(ws), queryFn: () => api.get<List<Project>>(`${w}/projects`), enabled: workspace.role !== "guest" });
  const headerKey = target || initialProject;
  const headerProject = projects.data?.items.find((p) => p.key === headerKey);
  const perms = useQuery({
    queryKey: queryKeys.permissions(ws, headerKey),
    queryFn: () => api.get<Permissions>(`${w}/projects/${encodeURIComponent(headerKey)}/my-permissions`),
    enabled: !!headerKey && workspace.role !== "guest",
  });
  const has = (p: string) => !!perms.data?.permissions.includes(p);
  const canUpdate = !!target && has("project.baseline");

  if (workspace.role === "guest") return <div className={styles.page}><Forbidden /></div>;

  const fresh = !job || !jobFor || jobFor.file !== file || jobFor.mode !== mode || (mode === "update" && jobFor.target !== target);

  async function run<T>(kind: "upload" | "patch" | "commit", fn: () => Promise<T>) {
    setBusy(kind);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function upload() {
    if (!file) return;
    if (!fresh) return setStep(2);
    const form = new FormData();
    form.append("file", file, file.name);
    form.append("mode", mode);
    if (mode === "update") form.append("projectKey", target);
    const created = await run("upload", () => api.post<ImportJob>(`${w}/import-jobs`, form));
    if (created) {
      setJob(created);
      setJobFor({ file, mode, target });
      setStep(2);
    }
  }

  async function patch(body: Record<string, unknown>) {
    if (!job) return;
    const updated = await run("patch", () => api.request<ImportJob>(`${w}/import-jobs/${job.id}`, { method: "PATCH", body }));
    if (updated) setJob(updated);
    return updated;
  }

  async function commit(pending: Record<string, unknown>) {
    if (!job) return;
    // ชื่อ / Key / เหตุผล บันทึกตอนกดนำเข้า (ไม่ PATCH ทุกครั้งที่พิมพ์)
    if (Object.keys(pending).length && !(await patch(pending))) return;
    const done = await run("commit", () => api.post<CommitResult>(`${w}/import-jobs/${job.id}/commit`));
    if (done) {
      setResult(done);
      void cache.invalidateQueries({ queryKey: queryKeys.projects(ws) });
    }
  }

  function restart() {
    setJob(null);
    setJobFor(null);
    setFile(null);
    setResult(null);
    setError(null);
    setStep(1);
  }

  const header = (
    <ImportHeader ws={ws} projectKey={headerProject?.key} projectName={headerProject?.name} active="import" hideTabs />
  );
  // เมนูด้านซ้าย + เนื้อหาด้านขวา แบบหน้า Report (ผู้ใช้ขอ 2026-11-09)
  const changesKey = headerKey && perms.isSuccess && has("project.baseline") ? headerKey : null;
  const layout = (content: ReactNode) => (
    <div className={styles.page}>
      {header}
      <div className={styles.layout}>
        <nav className={`${styles.card} ${styles.sideNav}`} aria-label={t("sections")}>
          {(["import", "export"] as const).map((s) => (
            <button key={s} type="button" className={`${styles.navItem} ${section === s ? styles.navOn : ""}`} aria-current={section === s ? "page" : undefined} onClick={() => setSection(s)}>{t(`section__${s}`)}</button>
          ))}
          {changesKey && <Link className={styles.navItem} href={`${w}/p/${encodeURIComponent(changesKey)}/plan-changes`}>{t("section__changes")}</Link>}
          <p className={styles.navNote}>{t("sectionNote")}</p>
        </nav>
        <div className={styles.main}>{content}</div>
      </div>
    </div>
  );
  if (section === "export") return layout(<ExportPanel ws={ws} projects={projects.data?.items} initialKey={target || initialProject} onProject={(k) => setTarget(k)} />);
  if (result) return layout(<Done ws={ws} result={result} onAgain={restart} />);

  const reach = (k: Step) => k === 1 || (!!job && !fresh);
  const stepNames = [t("step1"), t("step2"), t("step3"), t("step4")];
  return layout(
    <>
      <nav className={`${styles.card} ${styles.steps}`} aria-label={t("steps")}>
        {stepNames.map((n, i) => {
          const k = (i + 1) as Step;
          return (
            <button key={k} type="button" className={styles.st} aria-current={k === step ? "step" : undefined} disabled={!reach(k)} onClick={() => setStep(k)}>
              <span className={`${styles.sn} ${k < step ? styles.done : k === step ? styles.on : ""}`}>{k < step ? "✓" : k}</span>
              {n}
            </button>
          );
        })}
      </nav>

      {!!error && <ErrorState error={error} />}

      {step === 1 && (
        <section className={`${styles.card} ${styles.pad}`}>
          <FilePicker
            file={file}
            job={fresh ? null : job}
            error={fileError}
            onPick={(f) => {
              if (!/\.xlsx$/i.test(f.name)) return setFileError(t("onlyXlsx"));
              setFileError(null);
              setFile(f);
            }}
          />
          <div className={`muted ${styles.small} ${styles.template}`}>
            <span>{t("templateHint")}</span>
            <a className="button" href={`/api/v1/w/${encodeURIComponent(ws)}/import-template.xlsx`} download>{t("template")}</a>
          </div>
          <div className={styles.modes} role="radiogroup" aria-label={t("mode")}>
            <ModeCard on={mode === "create"} title={t("modeCreate")} hint={t("modeCreateHint")} onPick={() => setMode("create")} />
            <ModeCard on={mode === "update"} title={t("modeUpdate")} hint={t("modeUpdateHint")} onPick={() => setMode("update")} />
          </div>
          {mode === "update" && (
            <div style={{ maxWidth: 420 }}>
              {projects.isPending ? <LoadingState /> : projects.data?.items.length ? (
                <Select label={t("targetProject")} value={target} onChange={(e) => setTarget(e.target.value)} error={target && perms.isSuccess && !canUpdate ? t("noBaselinePerm") : undefined}>
                  <option value="" disabled>{t("pickProject")}</option>
                  {projects.data.items.map((p) => <option key={p.key} value={p.key}>{p.key} · {p.name}</option>)}
                </Select>
              ) : <p className="muted">{t("noProjects")}</p>}
            </div>
          )}
          <div className={styles.right}>
            {busy === "upload" && <span className="muted" role="status">{t("uploading")}</span>}
            <Button variant="primary" disabled={!file || busy !== null || (mode === "update" && !canUpdate)} onClick={() => void upload()}>{t("toStep2")}</Button>
          </div>
        </section>
      )}

      {step === 2 && job && <Mapping job={job} busy={busy === "patch"} onChange={(header, field) => void patch({ columnMapping: { [header]: field } })} onNext={() => setStep(3)} year={year} />}

      {step === 3 && job && (
        <Validate
          job={job}
          year={year}
          busy={busy === "patch"}
          onMissing={(body) => void patch(body)}
          onReupload={restart}
          onBack={() => setStep(2)}
          onNext={() => setStep(4)}
        />
      )}

      {step === 4 && job && <Confirm ws={ws} job={job} busy={busy} onPatch={(b) => void patch(b)} onBack={() => setStep(3)} onCommit={(pending) => void commit(pending)} />}
    </>
  );
}

function FilePicker({ file, job, error, onPick }: { file: File | null; job: ImportJob | null; error: string | null; onPick: (f: File) => void }) {
  const t = useTranslations("import-plan-changes.import");
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      className={styles.drop}
      data-over={over}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f) onPick(f);
      }}
    >
      <span className={styles.xlsx} aria-hidden="true">XLSX</span>
      <div className={styles.dropText}>
        {file ? (
          <>
            <b>{file.name}</b>
            <div className={`muted ${styles.small}`}>{job ? `${fmtSize(file.size)} · ${t("jobMeta", { sheet: job.sheet, rows: job.summary.rows })}` : t("fileMeta", { size: fmtSize(file.size) })}</div>
          </>
        ) : (
          <>
            <b>{t("drop")}</b>
            <div className={`muted ${styles.small}`}>{t("dropHint")}</div>
          </>
        )}
        {error && <div className="field-error" role="alert">{error}</div>}
      </div>
      <input
        ref={input}
        className={styles.hidden}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        aria-label={t("fileInput")}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = "";
        }}
      />
      <Button onClick={() => input.current?.click()}>{file ? t("changeFile") : t("chooseFile")}</Button>
    </div>
  );
}

function ModeCard({ on, title, hint, onPick }: { on: boolean; title: string; hint: string; onPick: () => void }) {
  return (
    <label className={styles.mode} data-on={on}>
      <input type="radio" name="import-mode" checked={on} onChange={onPick} />
      <span><b>{title}</b><span className={`muted ${styles.small} ${styles.block}`}>{hint}</span></span>
    </label>
  );
}

function Mapping({ job, busy, onChange, onNext, year }: { job: ImportJob; busy: boolean; onChange: (header: string, field: string | null) => void; onNext: () => void; year: YearFormat }) {
  const t = useTranslations("import-plan-changes.import");
  const cols = job.columns.filter((c) => c.header);
  const mapped = cols.filter((c) => c.field).length;
  const used = new Set(cols.map((c) => c.field).filter(Boolean));
  const b = (chunks: ReactNode) => <b>{chunks}</b>;
  return (
    <section className={styles.card}>
      <div className={styles.bar}>
        <b>{t("mapTitle")}</b>
        <Badge tone={mapped === cols.length ? "green" : "amber"}>{t("mapAuto", { mapped, total: cols.length })}</Badge>
      </div>
      <div className={`${styles.mp} ${styles.h}`}><span>{t("colExcel")}</span><span className={styles.arrow} /><span>{t("colField")}</span><span className={styles.sample}>{t("colSample")}</span></div>
      {cols.map((c) => (
        <div key={c.header} className={styles.mp} data-testid={`map-${c.header}`}>
          <b className={styles.ellipsis}>{c.header}</b>
          <span className={`muted ${styles.arrow}`} aria-hidden="true">→</span>
          <Select size="small" aria-label={t("fieldFor", { header: c.header })} value={c.field ?? ""} disabled={busy} onChange={(e) => onChange(c.header, e.target.value || null)}>
            <option value="">{t("skipColumn")}</option>
            {/* ฟิลด์หนึ่งจับคู่ได้คอลัมน์เดียว · ซ่อนฟิลด์ที่คอลัมน์อื่นใช้แล้ว */}
            {Object.entries(job.fields).filter(([f]) => f === c.field || !used.has(f)).map(([f, label]) => <option key={f} value={f}>{label}</option>)}
          </Select>
          <span className={`muted ${styles.ellipsis} ${styles.sample}`}>{showValue(c.sample, year)}</span>
        </div>
      ))}
      <div className={styles.rules}>
        <span>{t.rich("ruleStatus", { b })}</span>
        <span>{t.rich("ruleSize", { b })}</span>
        <span>{t.rich("ruleDevs", { b })}</span>
        <span className={styles.grow} />
        {busy && <span className="muted" role="status">{t("saving")}</span>}
        <Button variant="primary" disabled={busy} onClick={onNext}>{t("toStep3")}</Button>
      </div>
    </section>
  );
}

function Validate({ job, year, busy, onMissing, onReupload, onBack, onNext }: {
  job: ImportJob; year: YearFormat; busy: boolean;
  onMissing: (body: Record<string, unknown>) => void; onReupload: () => void; onBack: () => void; onNext: () => void;
}) {
  const t = useTranslations("import-plan-changes.import");
  const s = job.summary;
  const [filter, setFilter] = useState<Filter>("issue");
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [filter]);
  const count = { issue: job.findings.length, err: job.findings.filter((f) => f.level === "err").length, warn: job.findings.filter((f) => f.level === "warn").length };
  const rows = job.findings.filter((f) => filter === "issue" || f.level === filter);
  const ok = Math.max(0, s.rows - s.skipped);
  return (
    <>
      <section className={`${styles.card} ${styles.kpis}`} aria-label={t("step3")}>
        <Kpi label={t("kpiRows")} value={num(s.rows)} />
        <Kpi label={t("kpiModules")} value={num(s.modules)} />
        <Kpi label={t("kpiManDay")} value={num(s.manDay)} />
        <Kpi label={t("kpiPeople")} value={`${s.devs} / ${s.bas}`} />
        <Kpi label={t("kpiRange")} value={s.planFrom ? `${formatDate(s.planFrom, year)} – ${formatDate(s.planTo, year)}` : "—"} range />
      </section>
      {job.mode === "update" && job.diff && <DiffCard job={job} year={year} busy={busy} onMissing={onMissing} />}
      <section className={styles.card}>
        <div className={styles.chips} role="group" aria-label={t("filters")}>
          {(["issue", "err", "warn"] as Filter[]).map((f) => (
            <button key={f} type="button" className={styles.chip} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              <span className={styles.dot} style={{ background: CHIP[f] }} />
              {t(`chip__${f}`)} · {count[f]}
            </button>
          ))}
          <Badge tone="green">{t("chipReady", { count: ok })}</Badge>
          <span className={styles.grow} />
          <Button onClick={onReupload}>{t("reupload")}</Button>
        </div>
        <div className={`${styles.vr} ${styles.h}`}><span /><span>{t("colNo")}</span><span className={styles.hs}>{t("colModule")}</span><span>{t("colTask")}</span><span>{t("colResult")}</span><span className={styles.hs}>{t("colFix")}</span></div>
        {rows.length === 0 ? (
          <div className={`muted ${styles.note}`}>{job.findings.length ? t("noFindingsFilter") : t("noFindings")}</div>
        ) : rows.slice(0, limit).map((f, i) => <FindingRow key={`${f.rowNo}-${i}`} f={f} />)}
        {rows.length > limit && (
          <div className={styles.note}><Button size="small" onClick={() => setLimit(limit + PAGE)}>{t("showMore", { count: rows.length - limit })}</Button></div>
        )}
        {ok > 0 && <div className={`muted ${styles.note}`}>{t("readyMore", { count: ok })}</div>}
        <div className={`${styles.right} ${styles.note}`}>
          <Button onClick={onBack}>{t("back")}</Button>
          <Button variant="primary" disabled={busy} onClick={onNext}>{t("toStep4")}</Button>
        </div>
      </section>
    </>
  );
}

function Kpi({ label, value, range }: { label: string; value: string; range?: boolean }) {
  return <div className={styles.kp}><span className="muted">{label}</span><b className={range ? styles.range : undefined}>{value}</b></div>;
}

function FindingRow({ f }: { f: Finding }) {
  const t = useTranslations("import-plan-changes.import");
  const lv = LEVEL[f.level];
  return (
    <div className={styles.vr} data-testid="finding">
      <span className={styles.ic} style={{ background: lv.color }} role="img" aria-label={t(`level__${f.level}`)}>{lv.sym}</span>
      <span className={styles.mono}>{f.no !== null ? `#${f.no}` : "—"}</span>
      <span className={`${styles.hs} ${styles.ellipsis}`}>{f.module ?? "—"}</span>
      <span style={{ minWidth: 0 }}>
        <span className={styles.ellipsis} style={{ display: "block", fontWeight: 500 }}>{f.title ?? t("personRow")}</span>
        {f.rowNo > 0 && <span className="muted" style={{ fontSize: 11 }}>{t("rowNo", { row: f.rowNo })}</span>}
      </span>
      <span>{f.problem}</span>
      <span className={styles.hs}>{f.fix}</span>
    </div>
  );
}

function DiffCard({ job, year, busy, onMissing }: { job: ImportJob; year: YearFormat; busy: boolean; onMissing: (body: Record<string, unknown>) => void }) {
  const t = useTranslations("import-plan-changes.import");
  const d = job.diff!;
  const choice = (no: number) => job.missingChoice?.[String(no)] ?? job.missingAll ?? "keep";
  return (
    <section className={styles.card} aria-label={t("diffTitle")}>
      <div className={styles.bar}><b>{t("diffTitle")}</b><span className="muted">{t("diffSummary", { changed: d.changed.length, added: d.added.length, missing: d.missing.length, unchanged: d.unchanged })}</span></div>
      {d.changed.length > 0 && (
        <div className={styles.diff}>
          <h3>{t("diffChanged")}</h3>
          {d.changed.slice(0, 200).flatMap((c) => c.fields.map((f) => (
            <div key={`${c.key}-${f.field}`} className={styles.diffRow}>
              <span className={styles.mono}>{c.key}</span>
              <span className={styles.ellipsis}>{c.title} · <b>{f.label}</b></span>
              <span><span className={styles.old}>{showValue(f.old, year)}</span> → <span className={styles.new}>{showValue(f.new, year)}</span></span>
            </div>
          )))}
        </div>
      )}
      {d.added.length > 0 && (
        <div className={styles.diff}>
          <h3>{t("diffAdded")}</h3>
          {d.added.slice(0, 200).map((a) => (
            <div key={a.no} className={styles.diffRow}><span className={styles.mono}>{a.number !== null ? `#${a.number}` : t("addedNew")}</span><span className={styles.ellipsis}>{a.title}</span><span className="muted">{a.module}</span></div>
          ))}
        </div>
      )}
      {d.missing.length > 0 && (
        <div className={styles.diff}>
          <div className={styles.missRow}>
            <h3 style={{ gridColumn: "1 / 3" }}>{t("diffMissing")}</h3>
            <Select size="small" aria-label={t("missingAll")} value={job.missingAll ?? "keep"} disabled={busy} onChange={(e) => onMissing({ missingAll: e.target.value })}>
              <option value="keep">{t("missingAll")}: {t("missing__keep")}</option>
              <option value="delete">{t("missingAll")}: {t("missing__delete")}</option>
            </Select>
          </div>
          {d.missing.slice(0, 200).map((m) => (
            <div key={m.no} className={styles.missRow}>
              <span className={styles.mono}>{m.key}</span>
              <span className={styles.ellipsis}>{m.title} <span className="muted">· {m.status}</span></span>
              <Select size="small" aria-label={t("missingFor", { key: m.key })} value={choice(m.no)} disabled={busy} onChange={(e) => onMissing({ missing: { [String(m.no)]: e.target.value } })}>
                <option value="keep">{t("missing__keep")}</option>
                <option value="delete">{t("missing__delete")}</option>
              </Select>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Confirm({ ws, job, busy, onPatch, onBack, onCommit }: {
  ws: string; job: ImportJob; busy: null | "upload" | "patch" | "commit";
  onPatch: (body: Record<string, unknown>) => void; onBack: () => void; onCommit: (pending: Record<string, unknown>) => void;
}) {
  const t = useTranslations("import-plan-changes.import");
  const s = job.summary;
  const create = job.mode === "create";
  const [name, setName] = useState(job.project.name ?? "");
  const [key, setKey] = useState(job.project.key ?? "");
  const [reason, setReason] = useState(job.planChangeReason ?? "");
  const members = useQuery({
    queryKey: ["workspace", ws, "members"],
    queryFn: () => api.get<List<Member>>(`/w/${encodeURIComponent(ws)}/members`),
  });
  const pickable = (members.data?.items ?? []).filter((m) => m.status === "active" && m.role !== "guest");

  function pending() {
    const out: Record<string, unknown> = {};
    if (create) {
      const project: Record<string, string> = {};
      if (name.trim() && name.trim() !== job.project.name) project.name = name.trim();
      if (key.trim() && key.trim().toUpperCase() !== job.project.key) project.key = key.trim().toUpperCase();
      if (Object.keys(project).length) out.project = project;
    } else if (reason.trim() && reason.trim() !== job.planChangeReason) out.planChangeReason = reason.trim();
    return out;
  }

  const d = job.diff;
  const deleted = d ? d.missing.filter((m) => (job.missingChoice?.[String(m.no)] ?? job.missingAll ?? "keep") === "delete").length : 0;
  const total = create ? s.ready + s.backlog : s.ready;
  const undecided = job.people.filter((p) => !p.decided).length;
  const b = (chunks: ReactNode) => <b>{chunks}</b>;
  return (
    <section className={`${styles.card} ${styles.pad}`}>
      {create ? (
        <div className={styles.fields}>
          <Input label={t("projectName")} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} required />
          <Input label={t("projectKey")} hint={t("projectKeyHint")} value={key} maxLength={10} onChange={(e) => setKey(e.target.value.toUpperCase())} required />
        </div>
      ) : (
        <Input label={t("reason")} hint={t("reasonHint", { file: job.fileName })} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      )}
      <div className={styles.two}>
        <div>
          <b>{create ? t("willCreate") : t("willUpdate")}</b>
          {create ? (
            <ul className={styles.list}>
              <li>{t.rich("sumProject", { b, name: name || "—" })}</li>
              <li>{t("sumModules", { modules: s.modules })}</li>
              <li>{t("sumSprint")}</li>
              <li>{t("sumRows", { ready: s.ready, backlog: s.backlog, skipped: s.skipped })}</li>
              <li>{t("sumDates")}</li>
            </ul>
          ) : (
            <ul className={styles.list}>
              <li>{t("sumChanged", { changed: d?.changed.length ?? 0, added: d?.added.length ?? 0, skipped: s.skipped })}</li>
              {!!d?.missing.length && <li>{t("sumMissing", { missing: d.missing.length, deleted, kept: d.missing.length - deleted })}</li>}
              <li>{t("sumPlanChange")}</li>
            </ul>
          )}
        </div>
        <div>
          <b>{t("people")}</b>
          <div className={styles.people}>
            {job.people.length === 0 && <span className="muted">{t("noPeople")}</span>}
            {members.isPending && job.people.length > 0 ? <LoadingState /> : job.people.map((p) => <PersonRow key={p.name} p={p} members={pickable} disabled={busy !== null} onPatch={onPatch} />)}
            {job.people.length > 0 && <span className="muted">{t("peopleHint")}</span>}
            {undecided > 0 && <span className={styles.warnText}>{t("undecided", { count: undecided })}</span>}
          </div>
        </div>
      </div>
      {create && (
        <label className={styles.check}>
          <input type="checkbox" checked={job.setBaseline} disabled={busy !== null} onChange={(e) => onPatch({ setBaseline: e.target.checked })} />
          <span><b>{t("baseline")}</b><span className={`muted ${styles.small} ${styles.block}`}>{t("baselineHint")}</span></span>
        </label>
      )}
      <div className={styles.right}>
        {busy === "commit" && <span className="muted" role="status">{t("committing")}</span>}
        <Button onClick={onBack}>{t("back")}</Button>
        <Button variant="primary" disabled={busy !== null || (create && (!name.trim() || !key.trim()))} onClick={() => onCommit(pending())}>
          {create ? t("commitCreate", { count: total }) : t("commitUpdate", { count: total })}
        </Button>
      </div>
    </section>
  );
}

function PersonRow({ p, members, disabled, onPatch }: { p: JobPerson; members: Member[]; disabled: boolean; onPatch: (body: Record<string, unknown>) => void }) {
  const t = useTranslations("import-plan-changes.import");
  const k = personKey(p.name);
  const fromTarget = !p.decided ? "" : p.target === null ? "none" : "userId" in p.target ? `u:${p.target.userId}` : "email";
  const [emailMode, setEmailMode] = useState(fromTarget === "email");
  const [email, setEmail] = useState(p.target && "email" in p.target ? p.target.email : "");
  const value = emailMode ? "email" : fromTarget;
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const save = () => {
    if (valid && !(p.target && "email" in p.target && p.target.email === email.trim())) onPatch({ personMapping: { [k]: { email: email.trim() } } });
  };
  return (
    <div className={styles.person}>
      <b>{p.name}</b>
      <Badge>{p.roles.map((r) => t(`role__${r}`)).join("/")}</Badge>
      <div>
        <Select size="small" aria-label={t("matchFor", { name: p.name })} value={value} disabled={disabled} onChange={(e) => {
          const v = e.target.value;
          if (v === "email") return setEmailMode(true);
          setEmailMode(false);
          onPatch({ personMapping: { [k]: v === "none" ? null : { userId: v.slice(2) } } });
        }}>
          <option value="" disabled>{t("pickPerson")}</option>
          {members.map((m) => <option key={m.userId} value={`u:${m.userId}`}>{m.displayName} · {m.email}</option>)}
          <option value="none">{t("personNone")}</option>
          <option value="email">{t("personEmail")}</option>
        </Select>
        {emailMode && (
          <Input type="email" aria-label={t("emailFor", { name: p.name })} value={email} disabled={disabled} onChange={(e) => setEmail(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
        )}
      </div>
    </div>
  );
}

function Done({ ws, result, onAgain }: { ws: string; result: CommitResult; onAgain: () => void }) {
  const t = useTranslations("import-plan-changes.import");
  const p = `/w/${encodeURIComponent(ws)}/p/${encodeURIComponent(result.project.key)}`;
  const lines = useMemo(() => {
    const out = [
      result.mode === "create"
        ? t("doneCreate", { name: result.project.name, imported: result.imported ?? 0, scheduled: result.scheduled ?? 0, backlog: result.backlog ?? 0, skipped: result.skipped })
        : t("doneUpdate", { name: result.project.name, changed: result.changed ?? 0, added: result.added ?? 0, deleted: result.deleted ?? 0, planChanges: result.planChanges ?? 0 }),
    ];
    if (result.baseline) out.push(t("doneBaseline"));
    if (result.invitations.length) out.push(t("doneInvites", { count: result.invitations.length }));
    return out;
  }, [result, t]);
  return (
    <section className={`${styles.card} ${styles.done}`} role="status">
      <h2>{t("doneTitle")}</h2>
      {lines.map((l) => <div key={l}>{l}</div>)}
      <div className={styles.actions}>
        <Link className="button button-primary" href={`${p}/table`}>{t("openTable")}</Link>
        {(result.mode === "update" || result.baseline) && <Link className="button" href={`${p}/plan-changes`}>{t("openChanges")}</Link>}
        <Button onClick={onAgain}>{t("again")}</Button>
      </div>
    </section>
  );
}
