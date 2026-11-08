"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import { Button, ErrorState } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import type { Permissions } from "@/lib/types";
import { GROUPS, Highlight, KEY_RE, TypeIcon, bareQuery, hitHref, hitProjectKey, isIssue, issueHref, searchKey, useDebounced, type SearchHit, type SearchResult, type SearchType } from "./search-shared";
import styles from "./palette.module.css";

const LIMIT = 8;
const RECENT_MAX = 5;
type IconType = SearchType | "command";
interface Row { id: string; icon: IconType; iconLabel?: string; text: string; meta?: string; href: string; hint?: string; recent?: boolean }
interface Group { id: string; heading: string; rows: Row[] }

const recentKey = (ws: string) => `friday:palette-recent:${ws}`;
function readRecent(ws: string): Row[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(recentKey(ws)) ?? "[]");
    return Array.isArray(parsed) ? (parsed as Row[]).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}
function pushRecent(ws: string, row: Row) {
  try {
    const next = [{ ...row, id: `recent:${row.href}`, recent: true }, ...readRecent(ws).filter((r) => r.href !== row.href)].slice(0, RECENT_MAX);
    localStorage.setItem(recentKey(ws), JSON.stringify(next));
  } catch { /* เก็บประวัติไม่ได้ (private mode) ไม่ควรขวางการเปิดรายการ */ }
}

/**
 * Ctrl K · ค้นหางาน / โปรเจกต์ / คน / คำสั่ง (Canvas P1)
 * ข้อความของงานนี้เรียกเฉพาะใน PaletteBody ที่ render ตอนเปิด เพราะ shell วาง palette ไว้ทุกหน้า
 */
export function CommandPalette({ workspace, open, onOpenChange }: { workspace: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("common");
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="overlay" />
        <RadixDialog.Content className={styles.pal} aria-describedby={undefined}>
          <RadixDialog.Title className="sr-only">{t("features.commandTitle")}</RadixDialog.Title>
          <PaletteBody ws={workspace} close={() => onOpenChange(false)} />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

function PaletteBody({ ws, close }: { ws: string; close: () => void }) {
  const t = useTranslations("search-palette");
  const tc = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const { workspace, projects } = useWorkspace();
  const uid = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [recent] = useState(() => readRecent(ws));
  const base = `/w/${encodeURIComponent(ws)}`;

  // อยู่ในโปรเจกต์ = แสดงขอบเขต และให้ผลของโปรเจกต์นั้นขึ้นก่อน
  const projectKey = pathname.match(/\/p\/([^/]+)/)?.[1];
  const current = projects.find((p) => p.key === projectKey);
  const perms = useQuery({
    queryKey: queryKeys.permissions(ws, projectKey ?? ""),
    queryFn: () => api.get<Permissions>(`/w/${encodeURIComponent(ws)}/projects/${projectKey}/my-permissions`),
    enabled: !!projectKey,
  });

  const trimmed = q.trim();
  const mode = trimmed.startsWith(">") ? "command" : trimmed.startsWith("@") ? "person" : "all";
  const bare = bareQuery(q);
  const debounced = useDebounced(trimmed, 150);
  const apiQuery = debounced.startsWith("#") && !KEY_RE.test(debounced) ? bareQuery(debounced) : debounced;
  const params: Record<string, string> = { q: apiQuery, limit: String(LIMIT) };
  if (debounced.startsWith("@")) params.type = "person";
  const searching = mode !== "command" && !!bareQuery(debounced);
  const search = useQuery({
    queryKey: searchKey(ws, params),
    queryFn: () => api.get<SearchResult>(`/w/${encodeURIComponent(ws)}/search?${new URLSearchParams(params)}`),
    enabled: searching,
    placeholderData: (prev) => prev,
  });

  const commands = useMemo<Row[]>(() => {
    const list: (Row & { show: boolean })[] = [
      { id: "cmd:new", icon: "command", iconLabel: "+", text: t("commands.newIssue"), href: `${base}/p/${projectKey}?new=1`, hint: "C", show: !!projectKey && !!perms.data?.permissions.includes("issue.create") },
      { id: "cmd:my", icon: "command", text: t("commands.myTasks"), href: `${base}/my-tasks`, show: true },
      { id: "cmd:board", icon: "command", text: t("commands.board"), href: `${base}/p/${projectKey}/board`, show: !!projectKey },
      { id: "cmd:timeline", icon: "command", text: t("commands.timeline"), href: `${base}/p/${projectKey}/timeline`, show: !!projectKey },
      { id: "cmd:table", icon: "command", text: t("commands.table"), href: `${base}/p/${projectKey}/table`, show: !!projectKey },
      { id: "cmd:inbox", icon: "command", text: t("commands.inbox"), href: `${base}/inbox`, show: true },
      { id: "cmd:home", icon: "command", text: t("commands.home"), href: base, show: true },
      { id: "cmd:project", icon: "command", iconLabel: "+", text: t("commands.newProject"), href: `${base}/new-project`, show: workspace.role !== "guest" },
      // Import / Export อยู่ใต้โปรเจกต์ (ผู้ใช้ตัดสิน 2026-11-09)
      { id: "cmd:import", icon: "command", text: t("commands.import"), href: `${base}/p/${projectKey}/import`, show: workspace.role !== "guest" && !!projectKey },
      { id: "cmd:profile", icon: "command", text: t("commands.profile"), href: `${base}/profile`, show: true },
      { id: "cmd:search", icon: "command", text: t("commands.search"), href: `${base}/search`, show: true },
    ];
    return list.filter((c) => c.show).map(({ show: _show, ...c }) => ({ ...c, meta: t("meta.command") }));
  }, [t, base, projectKey, perms.data, workspace.role]);

  const groups = useMemo<Group[]>(() => {
    if (!trimmed) {
      const out: Group[] = [];
      if (recent.length) out.push({ id: "recent", heading: t("palette.recent"), rows: recent });
      out.push({ id: "frequent", heading: t("palette.frequent"), rows: commands.slice(0, 4) });
      return out;
    }
    const needle = bare.toLowerCase();
    const matchedCommands = commands.filter((c) => !needle || c.text.toLowerCase().includes(needle));
    if (mode === "command") return matchedCommands.length ? [{ id: "commands", heading: t("palette.group", { name: t("groups.commands"), count: matchedCommands.length }), rows: matchedCommands }] : [];

    const data = searching ? search.data : undefined;
    // ผลของโปรเจกต์ที่เปิดอยู่ขึ้นก่อน (sort แบบ stable คงลำดับความตรงจาก API)
    const items = [...(data?.items ?? [])].sort((a, b) => Number(hitProjectKey(b) === projectKey) - Number(hitProjectKey(a) === projectKey));
    const keyMatch = mode === "all" ? trimmed.match(KEY_RE) : null;
    const wantedKey = keyMatch ? `${keyMatch[1]!.toUpperCase()}-${keyMatch[2]}` : null;
    const out: Group[] = [];
    for (const g of GROUPS) {
      const hits = items.filter((h) => (g.types as readonly string[]).includes(h.type));
      if (wantedKey && g.id === "issues") hits.sort((a, b) => Number(isIssue(b) && b.key === wantedKey) - Number(isIssue(a) && a.key === wantedKey));
      const rows = hits.map((h) => toRow(ws, h, t));
      // `#DP-39` ไปที่งานได้ทันทีแม้ผลค้นหายังไม่กลับมา
      if (wantedKey && g.id === "issues" && !hits.some((h) => isIssue(h) && h.key === wantedKey))
        rows.unshift({ id: `jump:${wantedKey}`, icon: "task", text: t("palette.jump", { key: wantedKey }), meta: t("palette.jumpMeta"), href: issueHref(ws, wantedKey.split("-")[0]!, wantedKey) });
      if (!rows.length) continue;
      const count = Math.max(rows.length, g.types.reduce((n, type) => n + (data?.counts[type] ?? 0), 0));
      out.push({ id: g.id, heading: t("palette.group", { name: t(`groups.${g.id}`), count }), rows });
    }
    if (mode === "all" && matchedCommands.length) out.push({ id: "commands", heading: t("palette.group", { name: t("groups.commands"), count: matchedCommands.length }), rows: matchedCommands.slice(0, 4) });
    return out;
  }, [trimmed, bare, mode, recent, commands, searching, search.data, projectKey, ws, t]);

  const rows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  useEffect(() => setActive(0), [rows]);
  const activeId = rows[active] ? `${uid}-opt-${active}` : undefined;
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  function go(row: Row) {
    if (!row.id.startsWith("cmd:search")) pushRecent(ws, row);
    router.push(row.href);
    close();
  }
  function searchAll() {
    router.push(`${base}/search${trimmed && mode !== "command" ? `?q=${encodeURIComponent(trimmed)}` : ""}`);
    close();
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return; // พิมพ์ไทยผ่าน IME ยังไม่จบคำ
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!rows.length) return;
      setActive((i) => (i + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) searchAll();
      else if (rows[active]) go(rows[active]);
      else if (trimmed) searchAll();
    }
  }

  let index = -1;
  const loading = searching && search.isPending;
  const error = searching ? search.error : null;
  return (
    <>
      <div className={styles.head}>
        <button type="button" className={styles.iconBtn} aria-label={tc("app.search")} onClick={searchAll}>
          <Search size={18} aria-hidden />
        </button>
        <input
          ref={inputRef}
          autoFocus
          className={styles.input}
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("palette.placeholder")}
          aria-label={tc("app.search")}
          aria-controls={`${uid}-list`}
          aria-activedescendant={activeId}
          autoComplete="off"
          spellCheck={false}
        />
        {current && <span className={styles.pill} title={current.name}>{t("palette.scope", { name: current.name })}</span>}
        <span className={styles.kb}>{t("keys.esc")}</span>
      </div>
      <div className={styles.tries}>
        {(["tryCommand", "tryKey", "tryPerson"] as const).map((k) => (
          <button key={k} type="button" className={styles.try} onClick={() => { setQ(t(`palette.${k}`).charAt(0)); inputRef.current?.focus(); }}>
            {t("palette.try")} <span className={styles.mono}>{t(`palette.${k}`)}</span>
          </button>
        ))}
      </div>
      <div ref={listRef} className={styles.list} id={`${uid}-list`} role="listbox" aria-label={t("palette.results")}>
        {groups.map((g) => (
          <div key={g.id} role="group" aria-labelledby={`${uid}-${g.id}`}>
            <div className={styles.gh} id={`${uid}-${g.id}`}>{g.heading}</div>
            {g.rows.map((row) => {
              index++;
              const i = index;
              return (
                <div key={row.id} id={`${uid}-opt-${i}`} role="option" aria-selected={i === active} className={styles.ri} onMouseMove={() => setActive(i)} onClick={() => go(row)}>
                  <TypeIcon type={row.icon} label={row.iconLabel} />
                  <span className={styles.riText}>{row.recent ? row.text : <Highlight text={row.text} q={q} />}</span>
                  {row.meta && <span className={styles.riMeta}>{row.meta}</span>}
                  {row.hint && <span className={styles.kb}>{row.hint}</span>}
                  {i === 0 && !!trimmed && <span className={styles.kb}>{t("keys.enter")}</span>}
                </div>
              );
            })}
          </div>
        ))}
        {loading && !rows.length && <div className={styles.status} role="status">{t("palette.loading")}</div>}
        {error && (error instanceof ApiError && error.status === 403 ? <div className={styles.status} role="alert">{t("palette.forbidden")}</div> : <ErrorState error={error} retry={() => void search.refetch()} />)}
        {!!trimmed && !rows.length && !loading && !error && (!searching || search.data) && (
          <NoHit q={trimmed} onAdvanced={searchAll}>{t("palette.noHitHint")}</NoHit>
        )}
      </div>
      <div className={styles.foot}>
        <span><span className={styles.kb}>↑</span> <span className={styles.kb}>↓</span> {t("palette.select")}</span>
        <span><span className={styles.kb}>{t("keys.enter")}</span> {t("palette.open")}</span>
        <span className={styles.hideMobile}><span className={styles.kb}>{t("keys.ctrl")}</span> <span className={styles.kb}>{t("keys.enter")}</span> {t("palette.all")}</span>
        <span className={styles.spacer} />
        <span><span className={styles.mono}>&gt;</span> {t("palette.syntaxCommand")} · <span className={styles.mono}>#</span> {t("palette.syntaxKey")} · <span className={styles.mono}>@</span> {t("palette.syntaxPerson")}</span>
      </div>
    </>
  );
}

function NoHit({ q, onAdvanced, children }: { q: string; onAdvanced: () => void; children: ReactNode }) {
  const t = useTranslations("search-palette.palette");
  return (
    <div className={styles.noHit}>
      <b>{t("noHit", { q })}</b>
      <p>{children}</p>
      <Button onClick={onAdvanced}>{t("advanced")}</Button>
    </div>
  );
}

type T = ReturnType<typeof useTranslations>;
function toRow(ws: string, h: SearchHit, t: T): Row {
  const href = hitHref(ws, h);
  switch (h.type) {
    case "project": return { id: `project:${h.key}`, icon: "project", text: h.name, meta: h.archived ? `${h.key} · ${t("meta.archived")}` : h.key, href };
    case "comment": return { id: `comment:${h.commentId}`, icon: "comment", text: h.snippet ?? h.issueTitle, meta: `${h.issueKey} · ${h.project.name}`, href };
    case "file": return { id: `file:${h.id}`, icon: "file", text: h.name, meta: t("meta.files", { project: h.project.name }), href };
    case "person": return { id: `person:${h.id}`, icon: "person", text: h.displayName, meta: h.jobTitle ?? h.email, href };
    default: return { id: `issue:${h.key}`, icon: h.type, text: `${h.key} ${h.title}`, meta: `${h.project.name} · ${h.status.name}`, href };
  }
}
