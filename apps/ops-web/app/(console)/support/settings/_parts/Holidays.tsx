"use client";

// รอบ 4 · S1–S2 ปฏิทินวันหยุดของระบบ (ดึงจาก ธปท. / เพิ่มเอง) ในการ์ดเวลาทำการ · Owner และ Support แก้ได้
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Modal, Notice, TableSkeleton } from "@/components/kit";
import { Button, errorToast, InlineError, Input, Pill, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useFmt } from "../../../workspaces/_parts/format";

type Origin = "bot" | "manual";
interface Holiday {
  date: string;
  name: string;
  origin: Origin;
}
interface HolidayList {
  configured: boolean;
  syncedAt: string | null;
  failure: { since: string | null; message: string } | null;
  year: number | null;
  items: Holiday[];
}
interface Impact {
  projects: number;
  workspaces: number;
  issues: number;
}
type Kind = "new" | "changed" | "removed" | "renamed" | "origin" | "same";
interface Preview {
  year: number;
  total: number;
  items: { kind: Kind; date: string; name: string; from?: string }[];
  counts: Record<Kind, number>;
  impact: Impact;
  changedDates: number;
}

const KEY = ["ops", "support", "holidays"] as const;
const KIND_TONE: Record<Exclude<Kind, "same">, "ok" | "warn" | "bad" | "inf"> = { new: "ok", changed: "warn", removed: "bad", renamed: "inf", origin: "inf" };
/** "5 ธ.ค. 2569 (ศ.)" ตาม Canvas · วันที่ในแผนเป็น YYYY-MM-DD เวลาไทย */
const WEEKDAY = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
export const thaiDay = (date: string) => {
  const d = new Date(`${date}T00:00:00+07:00`);
  return `${d.toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric" })} (${WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()]})`;
};
const thisYear = () => Number(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" }).slice(0, 4));

export function SystemHolidays({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations("sset.holidays");
  const fmt = useFmt();
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<HolidayList>("/support/holidays") });
  const [dialog, setDialog] = useState<"bot" | "add" | "year" | { remove: Holiday } | null>(null);
  const d = q.data;
  return (
    <div className="holiday-cal" aria-label={t("title")} role="group">
      <div className="row">
        <b>{t("title")}</b>
        {d && (
          <span className="push-end">
            {!d.configured ? (
              <Pill>{t("notConfigured")}</Pill>
            ) : d.failure ? (
              <Pill tone="bad">{t("failed", { when: d.failure.since ? fmt.dateTime(d.failure.since) : "—" })}</Pill>
            ) : d.syncedAt ? (
              <Pill tone="ok">{t("synced", { when: fmt.dateTime(d.syncedAt) })}</Pill>
            ) : (
              <Pill>{t("never")}</Pill>
            )}
          </span>
        )}
      </div>
      {d && !d.configured && <p className="muted small">{t("notConfiguredNote")}</p>}
      {d?.configured && d.failure && <Notice tone="bad">{t("failedNote", { message: d.failure.message })}</Notice>}
      {q.isPending ? (
        <TableSkeleton rows={3} cols={3} />
      ) : q.error ? (
        <InlineError error={q.error} />
      ) : !d!.items.length ? (
        <p className="muted small">{t("empty")}</p>
      ) : (
        <HolidayTable items={d!.items.slice(0, 5)} canEdit={canEdit} onRemove={(h) => setDialog({ remove: h })} />
      )}
      <p className="muted small">{t("sharedNote")}</p>
      <div className="row">
        {canEdit && (
          <>
            <Button size="small" disabled={!d?.configured} onClick={() => setDialog("bot")}>
              <RefreshCw size={14} /> {t("fetch")}
            </Button>
            <Button size="small" onClick={() => setDialog("add")}>
              <Plus size={14} /> {t("add")}
            </Button>
          </>
        )}
        <Button size="small" onClick={() => setDialog("year")}>
          {t("year")}
        </Button>
      </div>
      {dialog === "bot" && <BotDialog onClose={() => setDialog(null)} />}
      {dialog === "add" && <AddDialog onClose={() => setDialog(null)} />}
      {dialog === "year" && <YearDialog canEdit={canEdit} onRemove={(h) => setDialog({ remove: h })} onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === "object" && <RemoveDialog holiday={dialog.remove} onClose={() => setDialog(null)} />}
    </div>
  );
}

function HolidayTable({ items, canEdit, onRemove }: { items: Holiday[]; canEdit: boolean; onRemove: (h: Holiday) => void }) {
  const t = useTranslations("sset.holidays");
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th scope="col">{t("col.date")}</th>
            <th scope="col">{t("col.name")}</th>
            <th scope="col">{t("col.origin")}</th>
            {canEdit && (
              <th scope="col">
                <span className="sr-only">{t("remove", { name: "" })}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((h) => (
            <tr key={h.date}>
              <td className="num">{thaiDay(h.date)}</td>
              <td className="cell-wrap">{h.name}</td>
              <td>
                <Pill tone={h.origin === "manual" ? "inf" : "neu"}>{t(`origin.${h.origin}`)}</Pill>
              </td>
              {canEdit && (
                <td>
                  {h.origin === "manual" && (
                    <Button size="icon" aria-label={t("remove", { name: h.name })} onClick={() => onRemove(h)}>
                      <Trash2 size={14} />
                    </Button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** ตัวเลือก "คำนวณ Plan End ใหม่" + "SLA คิดใหม่" และสรุปผลกระทบ (S2) */
function Options({ impact, value, onChange }: { impact: Impact | undefined; value: { recalc: boolean; sla: boolean }; onChange: (v: { recalc: boolean; sla: boolean }) => void }) {
  const t = useTranslations("sset.holidays");
  return (
    <>
      {impact && <Notice tone="warn">{t.rich("impact", { b: (c) => <b>{c}</b>, projects: impact.projects, workspaces: impact.workspaces, issues: impact.issues })}</Notice>}
      <label className="row">
        <input type="checkbox" checked={value.recalc} onChange={(e) => onChange({ ...value, recalc: e.target.checked })} />
        {t("recalc")}
      </label>
      <label className="row">
        <input type="checkbox" checked={value.sla} onChange={(e) => onChange({ ...value, sla: e.target.checked })} />
        {t("sla")}
      </label>
      <p className="muted small">{t("note")}</p>
    </>
  );
}

function useDone(msg: string, onClose: () => void) {
  const toast = useToast();
  const cache = useQueryClient();
  return {
    onSuccess: () => (toast(msg), void cache.invalidateQueries({ queryKey: ["ops", "support"] }), onClose()),
    onError: (e: unknown) => toast(errorToast(e)),
  };
}

/** S2 · ตรวจก่อนบันทึกวันหยุดที่ดึงมา */
function BotDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations("sset.holidays");
  const td = useTranslations("common.dialog");
  const [year, setYear] = useState(() => (new Date().getMonth() === 11 ? thisYear() + 1 : thisYear()));
  const [opts, setOpts] = useState({ recalc: true, sla: true });
  const p = useQuery({ queryKey: [...KEY, "bot", year], queryFn: () => api.post<Preview>("/support/holidays/bot/preview", { year }), retry: false, staleTime: 0, gcTime: 0 });
  const save = useMutation({ mutationFn: () => api.post("/support/holidays/bot/apply", { year, ...opts }), ...useDone(t("saved"), onClose) });
  const changes = p.data?.items.filter((i) => i.kind !== "same") ?? [];
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("previewTitle")} description={t("previewDesc", { year: year + 543 })}>
      <div className="dialog-body">
        <div className="row">
          <Button size="icon" aria-label={t("prev")} onClick={() => setYear((y) => y - 1)}>
            <ChevronLeft size={16} />
          </Button>
          <b>{year + 543}</b>
          <Button size="icon" aria-label={t("next")} onClick={() => setYear((y) => y + 1)}>
            <ChevronRight size={16} />
          </Button>
        </div>
        {p.isPending ? (
          <p className="muted small">{t("loading")}</p>
        ) : p.error ? (
          <InlineError error={p.error} />
        ) : !changes.length ? (
          <Notice tone="ok">{t("noChange", { year: year + 543 })}</Notice>
        ) : (
          <>
            <div className="tbl-wrap">
              <table className="tbl">
                <tbody>
                  {changes.slice(0, 6).map((i) => (
                    <tr key={`${i.kind}-${i.date}`}>
                      <td>
                        <Pill tone={KIND_TONE[i.kind as Exclude<Kind, "same">]}>{t(`kind.${i.kind as Exclude<Kind, "same">}`)}</Pill>
                      </td>
                      <td className="num">{i.from ? `${thaiDay(i.from)} → ${thaiDay(i.date)}` : thaiDay(i.date)}</td>
                      <td className="cell-wrap">{i.name}</td>
                    </tr>
                  ))}
                  {changes.length > 6 && (
                    <tr>
                      <td colSpan={3} className="muted small">
                        {t("more", { n: changes.length - 6 })}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <Options impact={p.data!.changedDates ? p.data!.impact : undefined} value={opts} onChange={setOpts} />
          </>
        )}
        <InlineError error={save.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{td("cancel")}</Button>
          <Button variant="primary" disabled={!p.data || !changes.length || save.isPending} onClick={() => save.mutate()}>
            {t("save", { n: p.data?.total ?? 0 })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const useImpact = (dates: string[]) =>
  useQuery({ queryKey: [...KEY, "impact", dates.join()], queryFn: () => api.post<Impact>("/support/holidays/impact", { dates }), enabled: dates.length > 0 && dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) });

function AddDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations("sset.holidays");
  const td = useTranslations("common.dialog");
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [opts, setOpts] = useState({ recalc: true, sla: true });
  const impact = useImpact(date ? [date] : []);
  const save = useMutation({ mutationFn: () => api.post("/support/holidays", { date, name: name.trim(), ...opts }), ...useDone(t("added"), onClose) });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("addTitle")} description={t("addDesc")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), date && name.trim() && save.mutate())}>
        <Input label={t("date")} type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        <Input label={t("name")} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        <Options impact={impact.data} value={opts} onChange={setOpts} />
        <InlineError error={save.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{td("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!date || !name.trim() || save.isPending}>
            {t("addSave")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RemoveDialog({ holiday, onClose }: { holiday: Holiday; onClose: () => void }) {
  const t = useTranslations("sset.holidays");
  const td = useTranslations("common.dialog");
  const [opts, setOpts] = useState({ recalc: true, sla: true });
  const impact = useImpact([holiday.date]);
  const save = useMutation({
    mutationFn: () => api.delete(`/support/holidays/${holiday.date}?recalc=${opts.recalc ? 1 : 0}&sla=${opts.sla ? 1 : 0}`),
    ...useDone(t("removed"), onClose),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("removeTitle", { name: holiday.name })} description={t("removeDesc", { date: thaiDay(holiday.date) })}>
      <div className="dialog-body">
        <Options impact={impact.data} value={opts} onChange={setOpts} />
        <InlineError error={save.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{td("cancel")}</Button>
          <Button variant="danger" disabled={save.isPending} onClick={() => save.mutate()}>
            {t("removeSave")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function YearDialog({ canEdit, onRemove, onClose }: { canEdit: boolean; onRemove: (h: Holiday) => void; onClose: () => void }) {
  const t = useTranslations("sset.holidays");
  const [year, setYear] = useState(thisYear);
  const q = useQuery({ queryKey: [...KEY, "year", year], queryFn: () => api.get<HolidayList>(`/support/holidays?year=${year}`) });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("yearTitle", { year: year + 543 })}>
      <div className="dialog-body">
        <div className="row">
          <Button size="icon" aria-label={t("prev")} onClick={() => setYear((y) => y - 1)}>
            <ChevronLeft size={16} />
          </Button>
          <b>{year + 543}</b>
          <Button size="icon" aria-label={t("next")} onClick={() => setYear((y) => y + 1)}>
            <ChevronRight size={16} />
          </Button>
        </div>
        {q.isPending ? <TableSkeleton rows={4} cols={3} /> : q.error ? <InlineError error={q.error} /> : !q.data.items.length ? <p className="muted small">{t("yearEmpty")}</p> : <HolidayTable items={q.data.items} canEdit={canEdit} onRemove={onRemove} />}
      </div>
    </Modal>
  );
}
