"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Avatar, Badge, Button, Dialog, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import { today, localeDateFormat } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AVATAR_ACCEPT, MAX_SOURCE_BYTES, squareAvatar } from "./avatar-image";
import { errorText, wsPath } from "./shared";
import { type Leave, type LineStatus, type Membership, type ProfileMe, profileKeys } from "./types";
import styles from "./profile.module.css";
import { DEFAULT_ITEM_COLOR, FALLBACK_PROJECT_COLOR } from "@/lib/colors";

const DAY_KEYS = ["", "mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** "จ.–ศ." ถ้าวันติดกัน ไม่งั้นเรียงทีละวัน */
export function useDaysLabel() {
  const t = useTranslations("profile.days");
  return (days: number[]) => {
    const sorted = [...days].sort();
    const consecutive = sorted.length > 2 && sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
    return consecutive ? `${t(`${DAY_KEYS[sorted[0]]}Short`)}–${t(`${DAY_KEYS[sorted.at(-1)!]}Short`)}` : sorted.map((d) => t(`${DAY_KEYS[d]}Short`)).join(" ");
  };
}

function useClock(timezone: string) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  try {
    const time = localeDateFormat({ hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone }).format(now);
    const offset = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "shortOffset" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "";
    return `${time} (${offset})`;
  } catch {
    return "";
  }
}

export function SummaryCard({ ws }: { ws: string }) {
  const t = useTranslations("profile.summary");
  const tr = useTranslations("common.roles");
  const { me: shellMe, workspace, projects } = useWorkspace();
  const me = shellMe as ProfileMe;
  const daysLabel = useDaysLabel();
  const [avatarOpen, setAvatarOpen] = useState(false);
  const base = wsPath(ws);
  const membership = useQuery({ queryKey: profileKeys.membership(ws), queryFn: () => api.get<Membership>(`${base}/me/membership`) });
  const line = useQuery({ queryKey: profileKeys.line, queryFn: () => api.get<LineStatus>("/me/line") });
  const leaves = useQuery({ queryKey: profileKeys.leaves(ws), queryFn: () => api.get<{ items: Leave[] }>(`${base}/leaves`) });
  // งานที่เปิดอยู่ / เลยกำหนด ของฉัน (my-issues นับเฉพาะงานที่ยังไม่เสร็จ)
  const stats = useQuery({
    queryKey: profileKeys.stats(ws),
    queryFn: () => api.get<{ counts: { assigned: number }; groups: { key: string; count: number }[] }>(`${base}/my-issues?tab=assigned&group=due`),
    retry: false,
  });
  const clock = useClock(me.timezone);
  const now = today();
  const onLeave = leaves.data?.items.some((l) => l.status === "approved" && l.startDate <= now && l.endDate >= now);
  const fullName = [me.firstName, me.lastName].filter(Boolean).join(" ");
  const m = membership.data;
  const joined = projects.filter((p) => p.joined);
  return (
    <aside className={cn("card", styles.summary)} aria-label={t("label")}>
      <div className={styles.summaryHead}>
        <span className={styles.bigAvatar}>
          <Avatar person={{ id: me.id, displayName: me.displayName, avatarUrl: me.avatarUrl, color: DEFAULT_ITEM_COLOR }} size="large" />
        </span>
        <Button size="small" onClick={() => setAvatarOpen(true)}>{t("changePhoto")}</Button>
        <div className={styles.name}>{me.displayName}</div>
        {(fullName || m?.jobTitle) && <div className={styles.muted}>{[fullName, m?.jobTitle].filter(Boolean).join(" · ")}</div>}
        <div className={styles.pills}>
          {onLeave ? <Badge tone="amber">● {t("onLeave")}</Badge> : <Badge tone="green">● {t("active")}</Badge>}
          <Badge tone="blue">{tr(workspace.role)}</Badge>
        </div>
      </div>
      <div className={styles.summaryBody}>
        <div className={styles.kv}><span className={styles.muted}>{t("email")}</span><span>{me.email}{me.emailVerified ? " ✓" : ""}</span></div>
        <div className={styles.kv}><span className={styles.muted}>{t("phone")}</span><span>{me.phone || "—"}</span></div>
        <div className={styles.kv}><span className={styles.muted}>LINE</span>{line.data?.linked ? <span className={styles.ok}>{t("lineLinked")}</span> : <span className={styles.muted}>{line.data ? t("lineNotLinked") : "—"}</span>}</div>
        <div className={styles.kv}><span className={styles.muted}>{t("localTime")}</span><span>{clock}</span></div>
        <div className={styles.kv}><span className={styles.muted}>{t("workHours")}</span><span>{m ? `${daysLabel(m.effective.workDays)} ${m.effective.workStart}–${m.effective.workEnd}` : "—"}</span></div>
        <div className={styles.kv}><span className={styles.muted}>Capacity</span><span>{m ? t("capacityValue", { hours: m.capacityHoursWeek }) : "—"}</span></div>
      </div>
      <div className={styles.summaryProjects}>
        <div className={cn(styles.muted, styles.small, styles.lb)} style={{ marginBottom: 6 }}>{t("projects")}</div>
        {joined.length === 0 && <div className={cn(styles.muted, styles.small)}>{t("noProjects")}</div>}
        {joined.map((p) => (
          <div className={styles.kv} key={p.id}>
            <span className={styles.projectName}><span className={styles.projectDot} style={{ background: p.color ?? FALLBACK_PROJECT_COLOR }} />{p.name}</span>
            {p.myRole && <Badge tone="blue">{tr(p.myRole as "admin")}</Badge>}
          </div>
        ))}
        {stats.data && (
          <div className={styles.stats}>
            <div className={styles.stat}><div className={cn(styles.muted, styles.small)}>{t("openTasks")}</div><div className={styles.statValue}>{stats.data.counts.assigned}</div></div>
            <div className={styles.stat}><div className={cn(styles.muted, styles.small)}>{t("overdueTasks")}</div><div className={styles.statValue}>{stats.data.groups.find((g) => g.key === "late")?.count ?? 0}</div></div>
          </div>
        )}
      </div>
      <AvatarDialog open={avatarOpen} onOpenChange={setAvatarOpen} current={me.avatarUrl ?? ""} />
    </aside>
  );
}

/** เลือกรูปจากเครื่อง → ครอปสี่เหลี่ยมและย่อในเบราว์เซอร์ → PUT /me/avatar (ผู้ใช้ขอแทนการใส่ลิงก์ 2026-11-11) */
function AvatarDialog({ open, onOpenChange, current }: { open: boolean; onOpenChange: (open: boolean) => void; current: string }) {
  const t = useTranslations("profile.avatar");
  const tc = useTranslations("common.app");
  const cache = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<{ blob: Blob; preview: string } | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (open) {
      setPicked(null);
      setError("");
    }
  }, [open]);
  // คืนหน่วยความจำของรูปตัวอย่างเมื่อเปลี่ยนรูปหรือปิด
  useEffect(() => () => { if (picked) URL.revokeObjectURL(picked.preview); }, [picked]);

  async function choose(file: File | undefined) {
    if (!file) return;
    setError("");
    if (!file.type.startsWith("image/")) return setError(t("notImage"));
    if (file.size > MAX_SOURCE_BYTES) return setError(t("tooLarge", { mb: MAX_SOURCE_BYTES / 1024 / 1024 }));
    try {
      const blob = await squareAvatar(file);
      setPicked({ blob, preview: URL.createObjectURL(blob) });
    } catch {
      setError(t("unreadable"));
    }
  }
  function apply(avatarUrl: string | null) {
    cache.setQueryData(queryKeys.me, (old: ProfileMe | undefined) => (old ? { ...old, avatarUrl } : old));
    void cache.invalidateQueries({ queryKey: queryKeys.me });
  }
  async function save() {
    if (!picked) return;
    setPending(true);
    setError("");
    try {
      const r = await api.request<{ avatarUrl: string }>("/me/avatar", { method: "PUT", body: picked.blob });
      apply(r.avatarUrl);
      toast({ message: t("saved") });
      onOpenChange(false);
    } catch (e) {
      setError(errorText(e, tc("unknownError")));
    } finally {
      setPending(false);
    }
  }
  async function remove() {
    setPending(true);
    setError("");
    try {
      await api.request("/me/avatar", { method: "DELETE" });
      apply(null);
      toast({ message: t("removed") });
      onOpenChange(false);
    } catch (e) {
      setError(errorText(e, tc("unknownError")));
    } finally {
      setPending(false);
    }
  }
  const shown = picked?.preview ?? current;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("title")} description={t("description")}>
      <div className={styles.avatarPick}>
        <span className={styles.avatarPreview}>{shown ? <img src={shown} alt={t("preview")} /> : <span aria-hidden="true">?</span>}</span>
        <div className={styles.avatarPickActions}>
          <input ref={input} type="file" accept={AVATAR_ACCEPT} hidden aria-label={t("choose")} onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ""; }} />
          <Button disabled={pending} onClick={() => input.current?.click()}>{picked || current ? t("chooseAnother") : t("choose")}</Button>
          <span className={cn(styles.muted, styles.small)}>{t("hint")}</span>
        </div>
      </div>
      {error && <p className={styles.danger} role="alert">{error}</p>}
      <div className="dialog-actions">
        {current && !picked && <Button disabled={pending} className={styles.danger} onClick={() => void remove()}>{t("remove")}</Button>}
        <Button disabled={pending} onClick={() => onOpenChange(false)}>{tc("cancel")}</Button>
        <Button variant="primary" disabled={pending || !picked} onClick={() => void save()}>{pending ? tc("saving") : tc("save")}</Button>
      </div>
    </Dialog>
  );
}
