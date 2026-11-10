"use client";

// ชิ้นส่วนของ O22 ที่ใช้ในหน้า Support: สถานะของฉัน · ทีมตอนนี้ · T4 ข้อความสำเร็จรูป
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquareText } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { hasAny } from "@/components/access";
import { Popover } from "@/components/kit";
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
  load: number;
}
interface Team {
  mode: "least" | "round" | "manual";
  items: TeamMember[];
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

function useTeam() {
  const me = useMe().data;
  return useQuery({ queryKey: TEAM_KEY, queryFn: () => api.get<Team>("/support/team"), enabled: hasAny(me, "owner", "support"), refetchInterval: 60_000 });
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

/** ทีมตอนนี้: สถานะ · กลุ่ม · งานเปิด / เพดาน */
export function TeamNow() {
  const t = useTranslations("sset");
  const team = useTeam();
  if (!team.data?.items.length) return null;
  return (
    <section className="card" aria-label={t("team.title")}>
      <div className="card-head">
        <h2 className="card-title">{t("team.title")}</h2>
        <span className="card-sub">{t(`team.${team.data.mode}`)}</span>
      </div>
      <div className="team-strip">
        {team.data.items.map((p) => {
          const pct = Math.min(100, Math.round((p.load / p.cap) * 100));
          return (
            <div key={p.staffId} className="person">
              <span className="avatar avatar-sm" aria-hidden="true">
                {initials(p.name)}
              </span>
              <span className="stack-tight" style={{ minWidth: 0, flex: 1 }}>
                <span className="row">
                  <b>{p.name}</b>
                  {p.groups
                    .filter((g) => g !== "lead")
                    .map((g) => (
                      <Pill key={g} tone={g === "fin" ? "warn" : "inf"}>
                        {t(`target.${g}`)}
                      </Pill>
                    ))}
                </span>
                <span className="muted small row">
                  <span className={`person-dot person-dot-${p.presence}`} aria-hidden="true" />
                  {t(`presence.short.${p.presence}`)}
                  {p.presenceNote && ` · ${p.presenceNote}`}
                </span>
                <span className="meter small">
                  <span className="hbar-track">
                    <span className={`hbar ${p.load >= p.cap ? "hbar-bad" : pct >= 75 ? "hbar-warn" : "hbar-primary"}`} style={{ width: `${pct}%` }} />
                  </span>
                  <span className="num">{t("team.load", { n: p.load, cap: p.cap })}</span>
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </section>
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
