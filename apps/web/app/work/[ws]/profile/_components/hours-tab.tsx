"use client";

import { useContext, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Badge, Button, ConfirmDialog, DatePicker, Dialog, Input, LoadingState, Select, type Tone, useToast, YearFormatContext } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate, today } from "@/lib/format";
import { cn } from "@/lib/utils";
import { copyText, errorText, SectionError, wsPath } from "./shared";
import { type Feed, type Leave, type Membership, profileKeys } from "./types";
import styles from "./profile.module.css";

const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const DAY_KEYS = ["", "mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const LEAVE_TONE: Record<Leave["status"], Tone> = { approved: "green", pending: "amber", rejected: "red" };
export const LEAVE_TYPES = ["vacation", "personal", "sick", "other"] as const;

interface HoursForm {
  capacity: string;
  workStart: string;
  workEnd: string;
  workDays: number[];
}
const formOf = (m: Membership): HoursForm => ({ capacity: String(m.capacityHoursWeek), workStart: m.effective.workStart, workEnd: m.effective.workEnd, workDays: [...m.effective.workDays].sort() });

/** ส่งเฉพาะที่ต่างจากค่าที่ใช้อยู่ · เวลาเริ่ม/เลิกส่งคู่กันเสมอ (API ตรวจคู่) */
export function hoursChanges(m: Membership, f: HoursForm) {
  const body: Partial<{ capacityHoursWeek: number; workStart: string; workEnd: string; workDays: number[] }> = {};
  if (Number(f.capacity) !== m.capacityHoursWeek) body.capacityHoursWeek = Number(f.capacity);
  if (f.workStart !== m.effective.workStart || f.workEnd !== m.effective.workEnd) Object.assign(body, { workStart: f.workStart, workEnd: f.workEnd });
  if ([...f.workDays].sort().join() !== [...m.effective.workDays].sort().join()) body.workDays = [...f.workDays].sort();
  return body;
}

export function HoursTab({ ws }: { ws: string }) {
  const t = useTranslations("profile.hours");
  const tc = useTranslations("common.app");
  const td = useTranslations("profile.days");
  const cache = useQueryClient();
  const toast = useToast();
  const base = wsPath(ws);
  const membership = useQuery({ queryKey: profileKeys.membership(ws), queryFn: () => api.get<Membership>(`${base}/me/membership`) });
  const [form, setForm] = useState<HoursForm | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (membership.data) setForm(formOf(membership.data));
  }, [membership.data]);

  if (membership.isPending) return <LoadingState />;
  if (membership.error) return <SectionError error={membership.error} retry={() => membership.refetch()} />;
  if (!form) return <LoadingState />;
  const m = membership.data;
  const changes = hoursChanges(m, form);
  const dirty = Object.keys(changes).length > 0;
  const capacity = Number(form.capacity);
  const invalid = !Number.isInteger(capacity) || capacity < 0 || capacity > 80 ? t("capacityInvalid") : !form.workDays.length ? t("daysRequired") : form.workStart >= form.workEnd ? t("timeInvalid") : "";
  const toggleDay = (d: number) => setForm({ ...form, workDays: form.workDays.includes(d) ? form.workDays.filter((x) => x !== d) : [...form.workDays, d] });

  async function save() {
    setPending(true);
    setError("");
    try {
      const updated = await api.request<Membership>(`${base}/me/membership`, { method: "PATCH", body: changes });
      cache.setQueryData(profileKeys.membership(ws), updated);
      toast({ message: t("saved") });
    } catch (e) {
      setError(errorText(e, tc("unknownError")));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className={styles.section}>
      <h2>{t("title")}</h2>
      <div className={styles.muted} style={{ fontSize: 12 }}>{t("description")}</div>
      <div className={styles.grid3}>
        <Input label={t("capacity")} type="number" min={0} max={80} step={1} value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} />
        <Input label={t("start")} type="time" value={form.workStart} onChange={(e) => setForm({ ...form, workStart: e.target.value })} />
        <Input label={t("end")} type="time" value={form.workEnd} onChange={(e) => setForm({ ...form, workEnd: e.target.value })} />
      </div>
      <div className={styles.fld}>
        <span className={styles.lb} id="work-days-label">{t("days")}</span>
        <div className={styles.days} role="group" aria-labelledby="work-days-label">
          {DAYS.map((d) => (
            <button type="button" key={d} className={styles.day} aria-pressed={form.workDays.includes(d)} aria-label={td(DAY_KEYS[d])} onClick={() => toggleDay(d)}>
              {td(`${DAY_KEYS[d]}Short`)}
            </button>
          ))}
        </div>
        {m.workStart === null && m.workDays === null && <span className={cn(styles.muted, styles.small)}>{t("usingWorkspace")}</span>}
      </div>
      {(invalid || error) && <p className="field-error" role="alert">{invalid || error}</p>}
      <div className={styles.actions}>
        <Button disabled={!dirty || pending} onClick={() => { setForm(formOf(m)); setError(""); }}>{tc("cancel")}</Button>
        <Button variant="primary" disabled={!dirty || pending || !!invalid} onClick={() => void save()}>{pending ? tc("saving") : t("saveHours")}</Button>
      </div>
      <Leaves ws={ws} />
      <CalendarFeeds ws={ws} />
    </div>
  );
}

function Leaves({ ws }: { ws: string }) {
  const t = useTranslations("profile.leaves");
  const { workspace } = useWorkspace();
  const year = useContext(YearFormatContext);
  const cache = useQueryClient();
  const base = wsPath(ws);
  const leaves = useQuery({ queryKey: profileKeys.leaves(ws), queryFn: () => api.get<{ items: Leave[] }>(`${base}/leaves`) });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Leave | null>(null);
  // Guest ลาไม่ได้ (A20) จึงไม่แสดงปุ่ม
  const canAdd = workspace.role !== "guest";
  const label = (l: Leave) => {
    const range = l.startDate === l.endDate ? formatDate(l.startDate, year, true) : `${formatDate(l.startDate, year, true)} – ${formatDate(l.endDate, year, true)}`;
    const type = (LEAVE_TYPES as readonly string[]).includes(l.leaveType) ? t(`type.${l.leaveType}`) : l.leaveType;
    return `${type} ${range}${l.halfDay ? ` (${t(`half.${l.halfDay}`)})` : ""}`;
  };
  return (
    <div className={styles.fld}>
      <span className={styles.lb}>{t("title")}</span>
      {leaves.isPending ? (
        <LoadingState />
      ) : leaves.error ? (
        <SectionError error={leaves.error} retry={() => leaves.refetch()} />
      ) : leaves.data.items.length === 0 ? (
        <span className={cn(styles.muted, styles.small)}>{t("empty")}</span>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label={t("title")}>
          {leaves.data.items.map((l) => (
            <li className={styles.kv} key={l.id}>
              <span>{label(l)}</span>
              <span className={styles.rowEnd}>
                <Badge tone={LEAVE_TONE[l.status]}>{t(`status.${l.status}`)}</Badge>
                {l.source === "hr" ? <span className={cn(styles.muted, styles.small)}>{t("fromHr")}</span> : <Button size="small" variant="ghost" className={styles.danger} aria-label={t("deleteLabel", { leave: label(l) })} onClick={() => setRemoving(l)}>{t("delete")}</Button>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canAdd && <Button style={{ alignSelf: "flex-start", marginTop: 6 }} onClick={() => setAdding(true)}>{t("add")}</Button>}
      <span className={cn(styles.muted, styles.small)}>{t("hint")}</span>
      <LeaveDialog ws={ws} open={adding} onOpenChange={setAdding} />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("deleteTitle")}
        description={removing ? label(removing) : undefined}
        confirmLabel={t("delete")}
        successMessage={t("deleted")}
        onConfirm={async () => {
          await api.delete(`${base}/leaves/${removing!.id}`);
          await cache.invalidateQueries({ queryKey: profileKeys.leaves(ws) });
        }}
      />
    </div>
  );
}

function LeaveDialog({ ws, open, onOpenChange }: { ws: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("profile.leaves");
  const tc = useTranslations("common.app");
  const cache = useQueryClient();
  const toast = useToast();
  const [leaveType, setLeaveType] = useState<string>("vacation");
  const [startDate, setStart] = useState(today());
  const [endDate, setEnd] = useState(today());
  const [halfDay, setHalfDay] = useState<"" | "am" | "pm">("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!open) return;
    setLeaveType("vacation");
    setStart(today());
    setEnd(today());
    setHalfDay("");
    setError("");
  }, [open]);
  const single = startDate === endDate;
  const invalid = !startDate || !endDate ? t("datesRequired") : endDate < startDate ? t("endBeforeStart") : "";
  async function submit() {
    setPending(true);
    setError("");
    try {
      await api.post(`${wsPath(ws)}/leaves`, { leaveType, startDate, endDate, ...(single && halfDay ? { halfDay } : {}) });
      await cache.invalidateQueries({ queryKey: profileKeys.leaves(ws) });
      toast({ message: t("created") });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ApiError && e.code === "leave_overlap" ? t("overlap") : errorText(e, tc("unknownError")));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)} title={t("addTitle")} description={t("addDescription")}>
      <Select label={t("typeLabel")} value={leaveType} onChange={(e) => setLeaveType(e.target.value)}>
        {LEAVE_TYPES.map((type) => <option key={type} value={type}>{t(`type.${type}`)}</option>)}
      </Select>
      <div className={styles.grid}>
        <DatePicker label={t("start")} value={startDate} onValueChange={(v) => { setStart(v); if (v && endDate < v) setEnd(v); }} />
        <DatePicker label={t("end")} value={endDate} min={startDate} onValueChange={setEnd} />
      </div>
      {single && (
        <Select label={t("halfLabel")} value={halfDay} onChange={(e) => setHalfDay(e.target.value as "" | "am" | "pm")}>
          <option value="">{t("half.full")}</option>
          <option value="am">{t("half.am")}</option>
          <option value="pm">{t("half.pm")}</option>
        </Select>
      )}
      {(invalid || error) && <p className="field-error" role="alert">{invalid || error}</p>}
      <div className="dialog-actions">
        <Button disabled={pending} onClick={() => onOpenChange(false)}>{tc("cancel")}</Button>
        <Button variant="primary" disabled={pending || !!invalid} onClick={() => void submit()}>{pending ? tc("saving") : t("submit")}</Button>
      </div>
    </Dialog>
  );
}

/** ลิงก์ iCal (A21) · URL มี token จึงแสดงครั้งเดียวตอนสร้าง ปิด Dialog แล้วดูซ้ำไม่ได้ */
function CalendarFeeds({ ws }: { ws: string }) {
  const t = useTranslations("profile.ical");
  const tc = useTranslations("common.app");
  const { projects } = useWorkspace();
  const year = useContext(YearFormatContext);
  const cache = useQueryClient();
  const toast = useToast();
  const feeds = useQuery({ queryKey: profileKeys.feeds(ws), queryFn: () => api.get<{ items: Feed[] }>(`/me/calendar-feeds?workspace=${encodeURIComponent(ws)}`) });
  const [scope, setScope] = useState("");
  const [created, setCreated] = useState<Feed | null>(null);
  const [revoking, setRevoking] = useState<Feed | null>(null);
  const [pending, setPending] = useState(false);
  const nameOf = (key: string | null) => (key ? (projects.find((p) => p.key === key)?.name ?? key) : t("allMine"));
  async function create() {
    setPending(true);
    try {
      const feed = await api.post<Feed>("/me/calendar-feeds", { workspace: ws, ...(scope ? { projectKey: scope } : {}) });
      setCreated(feed);
      await cache.invalidateQueries({ queryKey: profileKeys.feeds(ws) });
    } catch (e) {
      toast({ message: errorText(e, tc("unknownError")) });
    } finally {
      setPending(false);
    }
  }
  return (
    <div className={styles.fld}>
      <span className={styles.lb}>{t("title")}</span>
      <span className={cn(styles.muted, styles.small)}>{t("description")}</span>
      {feeds.isPending ? (
        <LoadingState />
      ) : feeds.error ? (
        <SectionError error={feeds.error} retry={() => feeds.refetch()} />
      ) : feeds.data.items.length === 0 ? (
        <span className={cn(styles.muted, styles.small)}>{t("empty")}</span>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label={t("title")}>
          {feeds.data.items.map((f) => (
            <li className={styles.kv} key={f.id}>
              <span>{nameOf(f.projectKey)} <span className={styles.muted}>· {t("createdAt", { date: formatDate(f.createdAt, year, true) })}</span></span>
              <Button size="small" variant="ghost" className={styles.danger} aria-label={t("revokeLabel", { name: nameOf(f.projectKey) })} onClick={() => setRevoking(f)}>{t("revoke")}</Button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.actionsStart} style={{ alignItems: "flex-end" }}>
        <Select label={t("scope")} value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">{t("allMine")}</option>
          {projects.filter((p) => p.joined).map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
        </Select>
        <Button disabled={pending} onClick={() => void create()}>{t("create")}</Button>
      </div>
      <Dialog open={!!created} onOpenChange={(open) => !open && setCreated(null)} title={t("createdTitle")} description={t("createdDescription")}>
        {created?.url && (
          <div className={styles.urlBox}>
            <code>{created.url}</code>
            <Button size="small" onClick={() => void copyText(created.url!).then(() => toast({ message: t("copied") }), () => undefined)}>{t("copy")}</Button>
          </div>
        )}
        <div className="dialog-actions"><Button variant="primary" onClick={() => setCreated(null)}>{t("done")}</Button></div>
      </Dialog>
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t("revokeTitle")}
        description={t("revokeDescription")}
        confirmLabel={t("revoke")}
        successMessage={t("revoked")}
        onConfirm={async () => {
          await api.delete(`/me/calendar-feeds/${revoking!.id}`);
          await cache.invalidateQueries({ queryKey: profileKeys.feeds(ws) });
        }}
      />
    </div>
  );
}
