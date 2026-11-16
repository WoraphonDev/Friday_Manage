"use client";

// ชิ้นส่วนของ O22 ที่ใช้ในหน้า Support: สถานะของฉัน · ทีมตอนนี้ · T4 ข้อความสำเร็จรูป
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquareText } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { hasAny } from "@/components/access";
import { Notice, Popover } from "@/components/kit";
import { Button, errorToast, Input, Pill, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { CANNED_KEY, type Canned, fillVariables, type Group, type Presence } from "./types";

interface TeamMember {
  staffId: string;
  name: string;
  groups: Group[];
  cap: number;
  presence: Presence;
  presenceNote: string | null;
  presenceAt?: string | null;
  /** manual = ตั้งเอง · logout / idle / session = ระบบเปลี่ยนเป็นออฟไลน์ (รอบ 4 · S3) */
  presenceReason?: "manual" | "logout" | "idle" | "session" | null;
  /** เรื่องที่คืนเข้าคิวตอนเปลี่ยนเป็นออฟไลน์ / ลา ครั้งล่าสุด */
  released?: number;
  load: number;
}
interface QueueItem {
  id: string;
  number: number;
  subject: string;
  priority: string;
  firstResponseDueAt: string | null;
  workspace: string | null;
  autoAssigned: { name: string; at: string } | null;
}
interface Team {
  mode: "least" | "round" | "manual";
  idleMinutes?: number | null;
  items: TeamMember[];
  me?: { presence: Presence; presenceReason: TeamMember["presenceReason"]; presenceAt: string | null; released: number } | null;
  queue?: { items: QueueItem[]; waiting: "no_online" | "all_full" | "manual" | null; redispatch: boolean };
}
const TEAM_KEY = ["ops", "support", "team"] as const;
const PRESENCE: Presence[] = ["online", "busy", "offline", "leave"];
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

/**
 * ทีมตอนนี้ · เรียกทุก 1 นาที · seen=1 เฉพาะตอนแท็บแสดงอยู่ = นับเป็นการใช้งาน (ออฟไลน์อัตโนมัติเมื่อไม่มีการใช้งาน · S3)
 * แท็บที่เปิดค้างแต่ไม่ได้ดูจึงไม่ทำให้ยัง "ออนไลน์"
 */
function useTeam() {
  const me = useMe().data;
  return useQuery({
    queryKey: TEAM_KEY,
    queryFn: () => api.get<Team>(`/support/team${typeof document === "undefined" || document.visibilityState === "visible" ? "?seen=1" : ""}`),
    enabled: hasAny(me, "owner", "support"),
    refetchInterval: 60_000,
  });
}

/** สถานะของฉัน (หัวหน้าจอ Support) · ออฟไลน์/ลา ทำตามที่ตั้งไว้ในหน้าตั้งค่า */
export function MyPresence() {
  const t = useTranslations("sset.presence");
  const me = useMe().data;
  const toast = useToast();
  const cache = useQueryClient();
  const team = useTeam();
  const mine = team.data?.items.find((m) => m.staffId === me?.id);
  const m = useMutation({
    mutationFn: (presence: Presence) => api.put<{ presence: Presence; released: number; leadsNotified: number }>("/support/presence", { presence }),
    onSuccess: (r) => {
      const extra = r.released ? ` · ${t("released", { n: r.released })}` : r.leadsNotified ? ` · ${t("leads")}` : "";
      toast(`${t("done", { state: t(`short.${r.presence}`) })}${extra}`);
      void cache.invalidateQueries({ queryKey: ["ops"] });
    },
    onError: (e) => toast(errorToast(e)),
  });
  if (!mine) return null;
  return (
    <label className="row small muted">
      {t("mine")}
      <select className="input select-inline" value={mine.presence} disabled={m.isPending} onChange={(e) => m.mutate(e.target.value as Presence)}>
        {PRESENCE.map((p) => (
          <option key={p} value={p}>
            {t(p)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SettingsLink() {
  const t = useTranslations("common.nav");
  return (
    <Link className="button" href="/support/settings">
      {t("supportSettings")}
    </Link>
  );
}

const hhmm = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) : "—");
const left = (iso: string) => {
  const m = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  return m <= 0 ? null : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
};

/** S3 · ทีมตอนนี้ (สถานะพร้อมเหตุที่ออฟไลน์) + คิวกลาง (สถานะการแจกใหม่) */
export function TeamNow() {
  const t = useTranslations("sset");
  const team = useTeam();
  if (!team.data?.items.length) return null;
  const { items, queue } = team.data;
  const state = (p: TeamMember) => {
    const short = t(`presence.short.${p.presence}`);
    if (p.presence !== "offline" || !p.presenceReason || p.presenceReason === "manual") return short;
    return p.presenceReason === "logout" ? t("team.byLogout", { state: short }) : t("team.auto", { state: short });
  };
  return (
    <div className="grid-2 team-now">
      <section className="card" aria-label={t("team.title")}>
        <div className="card-head">
          <h2 className="card-title">{t("team.title")}</h2>
          <span className="card-sub">{t("team.every")}</span>
        </div>
        <p className="muted small">{t(`team.${team.data.mode}`)}</p>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">{t("team.col.name")}</th>
                <th scope="col">{t("team.col.state")}</th>
                <th scope="col">{t("team.col.load")}</th>
                <th scope="col">{t("team.col.since")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.staffId}>
                  <td>
                    <span className="row nowrap">
                      <span className="avatar avatar-sm" aria-hidden="true">
                        {initials(p.name)}
                      </span>
                      <span className="stack-tight">
                        <b>{p.name}</b>
                        <span className="row">
                          {p.groups
                            .filter((g) => g !== "lead")
                            .map((g) => (
                              <Pill key={g} tone={g === "fin" ? "warn" : "inf"}>
                                {t(`target.${g}`)}
                              </Pill>
                            ))}
                        </span>
                      </span>
                    </span>
                  </td>
                  <td>
                    <span className="row nowrap small">
                      <span className={`person-dot person-dot-${p.presence}`} aria-hidden="true" />
                      {state(p)}
                    </span>
                    {p.presenceNote && <div className="muted small">{p.presenceNote}</div>}
                  </td>
                  <td className="num">{p.released ? t("team.loadReleased", { n: p.load, released: p.released }) : p.presence === "online" || p.presence === "busy" ? t("team.loadOf", { n: p.load, cap: p.cap }) : p.load}</td>
                  <td className="num muted">{hhmm(p.presenceAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {queue && (
        <section className="card" aria-label={t("queue.title")}>
          <div className="card-head">
            <h2 className="card-title">{t("queue.title")}</h2>
            <span className="card-sub">{queue.redispatch ? t("queue.sub") : t("queue.subOff")}</span>
          </div>
          {!queue.items.length ? (
            <p className="muted small">{t("queue.empty")}</p>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col">{t("queue.col.ticket")}</th>
                    <th scope="col">{t("queue.col.customer")}</th>
                    <th scope="col">{t("queue.col.sla")}</th>
                    <th scope="col">{t("queue.col.state")}</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.items.map((k) => {
                    const l = k.firstResponseDueAt ? left(k.firstResponseDueAt) : null;
                    return (
                      <tr key={k.id}>
                        <td className="cell-wrap">
                          <Link href={`/support?ticket=${k.id}`}>
                            #{k.number} {k.subject}
                          </Link>
                        </td>
                        <td>{k.workspace ?? "—"}</td>
                        <td>{k.firstResponseDueAt ? <Pill tone={l ? "warn" : "bad"}>{l ? t("queue.left", { time: l }) : t("queue.over")}</Pill> : "—"}</td>
                        <td>
                          {k.autoAssigned ? (
                            <Pill tone="inf">{t("queue.auto", { name: k.autoAssigned.name, time: hhmm(k.autoAssigned.at) })}</Pill>
                          ) : (
                            <Pill tone="warn">{queue.waiting ? t(`queue.waiting.${queue.waiting}`) : t("queue.next")}</Pill>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/** S5 · เปิดหน้า Support ครั้งแรกหลังระบบเปลี่ยนเป็นออฟไลน์ให้ · ปิดแล้วไม่ขึ้นซ้ำสำหรับการเปลี่ยนครั้งนั้น */
export function BackNotice() {
  const t = useTranslations("sset");
  const team = useTeam();
  const toast = useToast();
  const cache = useQueryClient();
  const mine = team.data?.me;
  const stamp = mine?.presenceAt ?? "";
  const [hidden, setHidden] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem("ops.support.back");
    } catch {
      return null;
    }
  });
  const online = useMutation({
    mutationFn: () => api.put<{ presence: Presence; redispatched?: number }>("/support/presence", { presence: "online" }),
    onSuccess: () => (toast(t("presence.done", { state: t("presence.short.online") })), void cache.invalidateQueries({ queryKey: ["ops"] })),
    onError: (e) => toast(errorToast(e)),
  });
  if (!mine || mine.presence !== "offline" || !mine.presenceReason || mine.presenceReason === "manual" || hidden === stamp) return null;
  const hide = () => {
    setHidden(stamp);
    try {
      sessionStorage.setItem("ops.support.back", stamp);
    } catch {
      // ที่เก็บของเบราว์เซอร์ปิดอยู่ · ซ่อนเฉพาะหน้านี้
    }
  };
  const why = t(`back.why.${mine.presenceReason}`, { n: team.data?.idleMinutes ?? 15 });
  return (
    <Notice
      tone="info"
      action={
        <span className="row nowrap">
          <Button variant="primary" size="small" disabled={online.isPending} onClick={() => online.mutate()}>
            {t("back.online")}
          </Button>
          <Button variant="ghost" size="small" onClick={hide}>
            {t("back.dismiss")}
          </Button>
        </span>
      }
    >
      {t.rich("back.text", { b: (c) => <b>{c}</b>, time: hhmm(mine.presenceAt), why })}
      {mine.released ? t("back.released", { n: mine.released }) : ""}
    </Notice>
  );
}

/** T4 · ข้อความสำเร็จรูป: เลือกแล้วแทนตัวแปรและใส่ในช่องตอบ · นับจำนวนครั้งที่ใช้ */
export function CannedPicker({ vars, onInsert }: { vars: { requester: string; workspace: string; ticket: number }; onInsert: (text: string) => void }) {
  const t = useTranslations("sset.t4");
  const me = useMe().data;
  const [q, setQ] = useState("");
  const list = useQuery({ queryKey: [...CANNED_KEY, false], queryFn: () => api.get<{ items: Canned[] }>("/support/canned-replies") });
  const use = useMutation({ mutationFn: (id: string) => api.post(`/support/canned-replies/${id}/use`, {}) });
  const term = q.trim().toLowerCase();
  const items = (list.data?.items ?? []).filter((c) => !term || `${c.title} ${c.tag ?? ""} ${c.body}`.toLowerCase().includes(term));
  return (
    <Popover
      label={t("title")}
      trigger={({ open, toggle }) => (
        <Button aria-expanded={open} onClick={toggle}>
          <MessageSquareText size={16} /> {t("open")}
        </Button>
      )}
    >
      {(close) => (
        <div className="stack" style={{ gap: 8 }}>
          <b>{t("title")}</b>
          <Input aria-label={t("search")} placeholder={t("search")} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="stack-tight" role="list">
            {!list.data ? null : !items.length ? (
              <p className="muted small">{list.data.items.length ? t("noMatch") : t("empty")}</p>
            ) : (
              items.slice(0, 8).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="listitem"
                  className="menu-item canned-item"
                  title={t("insert")}
                  onClick={() => {
                    onInsert(fillVariables(c.body, vars));
                    use.mutate(c.id);
                    close();
                  }}
                >
                  <span className="row">
                    {c.tag && <Pill tone="inf">{c.tag}</Pill>}
                    <b>{c.title}</b>
                  </span>
                  <span className="muted small clamp-1">{c.body}</span>
                  <span className="muted small">{t("uses", { n: c.uses })}</span>
                </button>
              ))
            )}
          </div>
          <span className="muted small">{t("vars")}</span>
          {hasAny(me, "owner") && (
            <Link className="small" href="/support/settings#canned" onClick={close}>
              {t("manage")}
            </Link>
          )}
        </div>
      )}
    </Popover>
  );
}
