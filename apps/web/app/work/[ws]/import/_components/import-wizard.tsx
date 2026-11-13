"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ChevronRight } from "lucide-react";
import { Badge, Button, ErrorState, Forbidden, Input, LoadingState, Select } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api } from "@/lib/api";
import { formatDate, type YearFormat } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import { cn } from "@/lib/utils";
import type { List, Permissions } from "@/lib/types";
import { type CommitResult, type Finding, type ImportJob, type JobPerson, type Member, personKey, type UpdateKind } from "./types";
import { num, showValue } from "./values";
import styles from "./import.module.css";

type Step = 1 | 2 | 3 | 4;
type Mode = "create" | "update";
type Filter = "issue" | "err" | "warn";
const PAGE = 100;
const LEVEL = { err: { color: "var(--danger-text)", sym: "!" }, warn: { color: "var(--warning-text)", sym: "!" } } as const;
const CHIP: Record<Filter, string> = { issue: "var(--warning-solid)", err: "var(--danger)", warn: "var(--warning-solid)" };

const fmtSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * ขั้นตอนนำเข้า Excel · โหมดกำหนดตามที่เปิด (ผู้ใช้ตัดสิน 2026-11-09: Import / Export อยู่ในโปรเจกต์)
 * projectKey = อัปเดตแผนของโปรเจกต์นั้น (หน้า /p/{key}/import) · ไม่มี = สร้างโปรเจกต์ใหม่จาก Excel (หน้า New project)
 * คืนเฉพาะเนื้อหา · กรอบหน้า / เมนูด้านซ้ายเป็นของหน้าที่เรียก
 */
export function ImportWizard({ ws, projectKey, changesHref }: { ws: string; projectKey?: string; changesHref?: string }) {
  const t = useTranslations("import-plan-changes.import");
  const { workspace, me } = useWorkspace();
  const year = me.yearFormat;
  const cache = useQueryClient();
  const w = `/w/${encodeURIComponent(ws)}`;
  const initialProject = projectKey ?? "";

  const [step, setStep] = useState<Step>(1);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const mode: Mode = projectKey ? "update" : "create";
  const target = initialProject;
  // นำเข้าเข้าโปรเจกต์เดิม: แทนที่ (จับคู่และแก้งานเดิม) หรือเพิ่มเติม (ทุกแถวเป็นงานใหม่)
  const [kind, setKind] = useState<UpdateKind>("replace");
  const [job, setJob] = useState<ImportJob | null>(null);
  // ไฟล์ / โหมด / โปรเจกต์ที่ใช้สร้าง job ปัจจุบัน · เปลี่ยนอย่างใดอย่างหนึ่ง = อัปโหลดใหม่
  const [jobFor, setJobFor] = useState<{ file: File; mode: Mode; target: string; kind: UpdateKind } | null>(null);
  const [busy, setBusy] = useState<null | "upload" | "patch" | "commit">(null);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<CommitResult | null>(null);

  const headerKey = target;
  const perms = useQuery({
    queryKey: queryKeys.permissions(ws, headerKey),
    queryFn: () => api.get<Permissions>(`${w}/projects/${encodeURIComponent(headerKey)}/my-permissions`),
    enabled: !!headerKey && workspace.role !== "guest",
  });
  const has = (p: string) => !!perms.data?.permissions.includes(p);
  const canUpdate = !!target && has("project.baseline");

  if (workspace.role === "guest") return <Forbidden />;

  const fresh = !job || !jobFor || jobFor.file !== file || jobFor.mode !== mode || (mode === "update" && (jobFor.target !== target || jobFor.kind !== kind));

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
    if (mode === "update") {
      form.append("projectKey", target);
      form.append("updateKind", kind);
    }
    const created = await run("upload", () => api.post<ImportJob>(`${w}/import-jobs`, form));
    if (created) {
      setJob(created);
      setJobFor({ file, mode, target, kind });
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
      // อัปเดตแผนจาก Popup ใน Table: แถวในตารางเปลี่ยนตามทันที
      if (projectKey) void cache.invalidateQueries({ queryKey: ["table", ws, projectKey] });
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

  if (result) return <Done ws={ws} result={result} onAgain={restart} changesHref={changesHref} />;

  const reach = (k: Step) => k === 1 || (!!job && !fresh);
  const stepNames = [t("step1"), t("step2"), t("step3"), t("step4")];
  return (
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
          {mode === "update" && (
            <div className={styles.kinds} role="group" aria-label={t("kindLabel")}>
              {(["replace", "unstarted", "append"] as const).map((k) => (
                <button key={k} type="button" className={styles.kind} aria-pressed={kind === k} onClick={() => setKind(k)}>
                  <b>{t(`kind__${k}`)}</b>
                  <span className="muted">{t(`kind__${k}Hint`)}</span>
                </button>
              ))}
            </div>
          )}
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
          {mode === "update" && perms.isSuccess && !canUpdate && <p className="field-error">{t("noBaselinePerm")}</p>}
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
            <div className={`muted ${styles.small}`}>{job ? `${fmtSize(file.size)} · ${(job.summary.checklist ? t("jobMetaChecklist", { sheet: job.sheet, rows: job.summary.rows, checklist: job.summary.checklist }) : t("jobMeta", { sheet: job.sheet, rows: job.summary.rows }))}` : t("fileMeta", { size: fmtSize(file.size) })}</div>
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

type DiffTab = "missing" | "changed" | "added" | "locked";

/**
 * ผลเทียบกับแผนปัจจุบัน · แผนจริงมีหลายร้อยแถว จึงแยกเป็นแท็บ (งานที่หายจากไฟล์ซึ่งต้องตัดสินใจก่อน) มีช่องค้นหา
 * จัดงานใหม่เป็นกลุ่มตาม Module ที่พับได้ และจำกัดความสูงให้เลื่อนในการ์ดแทนการยืดทั้งหน้า
 */
function DiffCard({ job, year, busy, onMissing }: { job: ImportJob; year: YearFormat; busy: boolean; onMissing: (body: Record<string, unknown>) => void }) {
  const t = useTranslations("import-plan-changes.import");
  const d = job.diff!;
  const choice = (no: number) => job.missingChoice?.[String(no)] ?? job.missingAll ?? "keep";
  const counts: Record<DiffTab, number> = { missing: d.missing.length, changed: d.changed.length, added: d.added.length, locked: d.locked?.length ?? 0 };
  const tabs = (["missing", "changed", "added", "locked"] as const).filter((k) => counts[k] > 0);
  // อัปเดตเฉพาะงานที่ยังไม่เริ่ม: มีงานใหม่ที่ยังไม่ยืนยัน → เปิดแท็บงานใหม่ก่อนให้ตัดสินใจ
  const unstarted = job.updateKind === "unstarted";
  const askNew = unstarted && counts.added > 0;
  const [picked, setPicked] = useState<DiffTab | null>(null);
  const tab = picked && counts[picked] > 0 ? picked : askNew && !job.addNew ? "added" : tabs[0];
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const hit = (...parts: (string | null | undefined)[]) => !q || parts.some((p) => p?.toLowerCase().includes(q));
  // กลุ่ม Module ของงานใหม่: รายการยาวพับไว้ก่อน · ค้นหาแล้วกางทุกกลุ่มที่มีผล
  const [open, setOpen] = useState<Set<string>>(() => new Set(d.added.length <= 30 ? d.added.map((a) => a.module) : []));
  const toggle = (m: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(m)) next.delete(m); else next.add(m);
    return next;
  });

  const changed = d.changed.filter((c) => hit(c.key, c.title, ...c.fields.map((f) => f.label)));
  const missing = d.missing.filter((m) => hit(m.key, m.title, m.status));
  const added = d.added.filter((a) => hit(a.title, a.module, a.number !== null ? `#${a.number}` : null));
  const locked = (d.locked ?? []).filter((l) => hit(l.key, l.title, l.status));
  const modules = [...new Set(added.map((a) => a.module))];
  const shown = tab === "changed" ? changed.length : tab === "missing" ? missing.length : tab === "locked" ? locked.length : added.length;

  return (
    <section className={styles.card} aria-label={t("diffTitle")}>
      <div className={styles.bar}><b>{t("diffTitle")}</b><span className="muted">{t("diffSummary", { changed: d.changed.length, added: d.added.length, missing: d.missing.length, unchanged: d.unchanged })}</span></div>
      {tab && (
        <>
          <div className={styles.diffTools}>
            <div className={styles.diffTabs} role="tablist" aria-label={t("diffTitle")}>
              {tabs.map((k) => (
                <button key={k} type="button" role="tab" id={`diff-tab-${k}`} aria-controls="diff-panel" aria-selected={tab === k} onClick={() => setPicked(k)}>
                  {t(`diffTab__${k}`)} <span className={styles.diffCount}>{num(counts[k])}</span>
                </button>
              ))}
            </div>
            <input className={cn("input", styles.diffSearch)} type="search" placeholder={t("diffSearch")} aria-label={t("diffSearch")} value={query} onChange={(e) => setQuery(e.target.value)} />
            {tab === "missing" && (
              <Select size="small" aria-label={t("missingAll")} value={job.missingAll ?? "keep"} disabled={busy} onChange={(e) => onMissing({ missingAll: e.target.value })}>
                <option value="keep">{t("missingAll")}: {t("missing__keep")}</option>
                <option value="delete">{t("missingAll")}: {t("missing__delete")}</option>
              </Select>
            )}
          </div>
          <div id="diff-panel" role="tabpanel" aria-labelledby={`diff-tab-${tab}`} className={styles.diffPanel}>
            <p className={`muted ${styles.small}`}>{t(tab === "added" && unstarted ? "diffHint__addedAsk" : `diffHint__${tab}`)}</p>
            {tab === "added" && askNew && <AddNewCheck job={job} busy={busy} onPatch={onMissing} />}
            {tab === "locked" && locked.map((l) => (
              <div key={l.key} className={styles.changeRow}>
                <span className={styles.mono}>{l.key}</span>
                <span className={styles.ellipsis} title={l.title}>{l.title} <span className="muted">· {l.status}</span></span>
                <span className="muted">{t("lockedFields", { fields: l.fields.join(", ") })}</span>
              </div>
            ))}
            {shown === 0 && <p className="muted">{t("diffNoMatch")}</p>}
            {tab === "changed" && changed.map((c) => (
              <div key={c.key} className={styles.changeRow}>
                <span className={styles.mono}>{c.key}</span>
                <span className={styles.ellipsis} title={c.title}>{c.title}</span>
                <span className={styles.changeFields}>
                  {c.fields.map((f) => (
                    <span key={f.field} className={styles.changeField}><b>{f.label}</b> <span className={styles.old}>{showValue(f.old, year)}</span> → <span className={styles.new}>{showValue(f.new, year)}</span></span>
                  ))}
                </span>
              </div>
            ))}
            {tab === "missing" && missing.map((m) => (
              <div key={m.no} className={styles.missRow}>
                <span className={styles.mono}>{m.key}</span>
                <span className={styles.ellipsis} title={m.title}>{m.title} <span className="muted">· {m.status}</span></span>
                <Select size="small" aria-label={t("missingFor", { key: m.key })} value={choice(m.no)} disabled={busy} onChange={(e) => onMissing({ missing: { [String(m.no)]: e.target.value } })}>
                  <option value="keep">{t("missing__keep")}</option>
                  <option value="delete">{t("missing__delete")}</option>
                </Select>
              </div>
            ))}
            {tab === "added" && modules.map((m) => {
              const rows = added.filter((a) => a.module === m);
              const expanded = !!q || open.has(m);
              return (
                <div key={m || "-"} className={styles.diffGroup}>
                  <button type="button" className={styles.diffGroupHead} aria-expanded={expanded} onClick={() => toggle(m)}>
                    <ChevronRight size={14} aria-hidden="true" className={styles.diffChevron} />
                    <b>{m || t("diffNoModule")}</b>
                    <span className="muted">{t("diffGroupCount", { count: rows.length })}</span>
                  </button>
                  {expanded && rows.map((a) => (
                    <div key={a.no} className={styles.diffRow}><span className={styles.mono}>{a.number !== null ? `#${a.number}` : t("addedNew")}</span><span className={styles.ellipsis} title={a.title}>{a.title}</span></div>
                  ))}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

/** ยืนยันเพิ่มงานใหม่ในโหมดอัปเดตเฉพาะงานที่ยังไม่เริ่ม (ค่าเริ่มต้นไม่เพิ่ม · ผู้ใช้ขอให้ถามก่อน 2026-11-11) */
function AddNewCheck({ job, busy, onPatch }: { job: ImportJob; busy: boolean; onPatch: (body: Record<string, unknown>) => void }) {
  const t = useTranslations("import-plan-changes.import");
  return (
    <label className={`${styles.check} ${styles.addNew}`}>
      <input type="checkbox" checked={!!job.addNew} disabled={busy} onChange={(e) => onPatch({ addNew: e.target.checked })} />
      <span><b>{t("addNew", { count: job.diff?.added.length ?? 0 })}</b><span className={`muted ${styles.small} ${styles.block}`}>{t("addNewHint")}</span></span>
    </label>
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
              <li>{t("sumChanged", { changed: d?.changed.length ?? 0, added: job.updateKind === "unstarted" && !job.addNew ? 0 : (d?.added.length ?? 0), skipped: s.skipped })}</li>
              {!!d?.locked?.length && <li>{t("sumLocked", { count: d.locked.length })}</li>}
              {job.updateKind === "unstarted" && !!d?.added.length && !job.addNew && <li className={styles.warnText}>{t("sumNotAdded", { count: d.added.length })}</li>}
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
      {job.updateKind === "unstarted" && !!d?.added.length && <AddNewCheck job={job} busy={busy !== null} onPatch={onPatch} />}
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

function Done({ ws, result, onAgain, changesHref }: { ws: string; result: CommitResult; onAgain: () => void; changesHref?: string }) {
  const t = useTranslations("import-plan-changes.import");
  const p = `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(result.project.key)}`;
  const lines = useMemo(() => {
    const out = [
      result.mode === "create"
        ? t("doneCreate", { name: result.project.name, imported: result.imported ?? 0, scheduled: result.scheduled ?? 0, backlog: result.backlog ?? 0, skipped: result.skipped })
        : t("doneUpdate", { name: result.project.name, changed: result.changed ?? 0, added: result.added ?? 0, deleted: result.deleted ?? 0, planChanges: result.planChanges ?? 0 }),
    ];
    if (result.checklist) out.push(t("doneChecklist", { count: result.checklist }));
    if (result.baseline) out.push(t("doneBaseline"));
    if (result.invitations.length) out.push(t("doneInvites", { count: result.invitations.length }));
    return out;
  }, [result, t]);
  return (
    <section className={`${styles.card} ${styles.doneCard}`} role="status">
      <h2>{t("doneTitle")}</h2>
      {lines.map((l) => <div key={l}>{l}</div>)}
      <div className={styles.actions}>
        <Link className="button button-primary" href={`${p}/table`}>{t("openTable")}</Link>
        {(result.mode === "update" || result.baseline) && <Link className="button" href={changesHref ?? `${p}/table?io=changes`}>{t("openChanges")}</Link>}
        <Button onClick={onAgain}>{t("again")}</Button>
      </div>
    </section>
  );
}
