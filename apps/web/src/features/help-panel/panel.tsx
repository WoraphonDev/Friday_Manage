"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { BookOpen, ChevronRight, CircleHelp, ExternalLink, Keyboard, Server, X } from "lucide-react";
import { Button, Drawer, DrawerClose } from "@/components/ui";
import { useContactSupport, type ContactWorkspace } from "./contact";
import { isTyping } from "./home";
import { SearchBox, SearchResults, useDebounced } from "./search";
import { helpApi, helpKeys, isRoute, routeLabelKey, routeOf } from "./shared";
import { WhatsNewCard } from "@/features/whats-new/WhatsNew";
import styles from "./help.module.css";

/** ชื่อหน้าที่เปิดอยู่ เช่น "แผนพัฒนาผลิตภัณฑ์ › Gantt" (แนบในฟอร์มติดต่อ Support) */
export function usePageLabel(projects: { key: string; name: string }[]) {
  const t = useTranslations("help.routes");
  const pathname = usePathname();
  const route = routeOf(pathname);
  const key = /\/p\/([^/]+)/.exec(pathname)?.[1];
  const project = key ? projects.find((p) => p.key === decodeURIComponent(key)) : null;
  const label = t(routeLabelKey(route));
  return { route, label, page: project ? `${project.name} › ${label}` : label, path: pathname };
}

function Panel({ workspace, projects, onClose }: { workspace: ContactWorkspace; projects: { key: string; name: string }[]; onClose: () => void }) {
  const t = useTranslations("help.panel");
  const tr = useTranslations("help");
  const base = `/work/${encodeURIComponent(workspace.slug)}/help`;
  const [query, setQuery] = useState("");
  const [keys, setKeys] = useState(false);
  const q = useDebounced(query);
  const page = usePageLabel(projects);
  const canContact = workspace.role !== "guest";
  const suggested = useQuery({
    queryKey: helpKeys.list(`route:${page.route}`),
    queryFn: () => helpApi.articles({ route: page.route, limit: 3 }),
    enabled: isRoute(page.route),
  });
  const tickets = useQuery({ queryKey: helpKeys.tickets(workspace.slug, "mine"), queryFn: () => helpApi.tickets(workspace.slug, "mine"), enabled: canContact });
  const contact = useContactSupport(workspace);
  const href = (slug: string) => `${base}/${encodeURIComponent(slug)}`;
  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <h2>{t("title")}</h2>
        <Link href={base} className="button button-ghost button-icon" aria-label={t("openFull")} title={t("openFull")} onClick={onClose}>
          <ExternalLink size={16} />
        </Link>
        <DrawerClose asChild>
          <Button variant="ghost" size="icon" aria-label={tr("contact.close")}>
            <X size={18} />
          </Button>
        </DrawerClose>
      </div>
      <SearchBox value={query} onChange={setQuery} autoFocus compact />
      {q.trim() ? (
        <SearchResults query={q} articleHref={href} onNavigate={onClose} onAsk={canContact ? (v) => contact.open({ searchQuery: v, page: page.page, path: page.path }) : undefined} />
      ) : (
        <>
          <section className={styles.panelSection}>
            <b>{suggested.data?.fallback ? t("popular") : t("suggested", { page: page.label })}</b>
            <div className={styles.panelList}>
              {suggested.data?.items.map((a) => (
                <Link key={a.id} href={href(a.slug)} onClick={onClose}>
                  <span>{a.title}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </Link>
              ))}
            </div>
          </section>
          <section className={styles.panelSection}>
            <b>{t("shortcuts")}</b>
            <div className={styles.panelList}>
              <WhatsNewCard ws={workspace.slug} role={workspace.role} />
              <Link href={base} onClick={onClose}>
                <BookOpen size={16} aria-hidden="true" />
                <span>{t("allHelp")}</span>
              </Link>
              <button type="button" aria-expanded={keys} onClick={() => setKeys(!keys)}>
                <Keyboard size={16} aria-hidden="true" />
                <span>{t("keys")}</span>
                <kbd>?</kbd>
              </button>
              {keys && (
                <dl className={styles.keys}>
                  <dt>
                    <kbd>Ctrl K</kbd>
                  </dt>
                  <dd>{t("keyList.palette")}</dd>
                  <dt>
                    <kbd>?</kbd>
                  </dt>
                  <dd>{t("keyList.help")}</dd>
                  <dt>
                    <kbd>/</kbd>
                  </dt>
                  <dd>{t("keyList.focus")}</dd>
                  <dt>
                    <kbd>Ctrl 1–9</kbd>
                  </dt>
                  <dd>{t("keyList.switch")}</dd>
                </dl>
              )}
              <div className={styles.panelStatic}>
                <Server size={16} aria-hidden="true" />
                <span>{t("status")}</span>
                <small className="muted">{t("statusOk")}</small>
              </div>
            </div>
          </section>
          {canContact && (
            <section className={styles.stuckBox}>
              <b>{t("stuck")}</b>
              <p className="muted">{t("stuckHint")}</p>
              <Button variant="primary" onClick={() => contact.open({ page: page.page, path: page.path })}>
                {tr("home.contact")}
              </Button>
              <Link href={`${base}/tickets`} className={styles.smallLink} onClick={onClose}>
                {tr("home.myTickets", { count: tickets.data?.openMine ?? 0 })}
              </Link>
            </section>
          )}
        </>
      )}
      {contact.element}
    </div>
  );
}

/**
 * ปุ่ม "?" บนแถบบน + คีย์ลัด ? (ไม่ทำงานขณะพิมพ์) · เปิดแผงช่วยเหลือ X4 ด้านขวา · ไม่ปิดหน้าที่ทำอยู่
 * โหลดข้อมูลเมื่อเปิดแผงเท่านั้น
 */
export function HelpButton({ workspace, projects }: { workspace: ContactWorkspace; projects: { key: string; name: string }[] }) {
  const t = useTranslations("help.panel");
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "?" || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      event.preventDefault();
      setOpen((o) => !o);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      <Button variant="ghost" size="icon" className={styles.helpButton} aria-label={t("open")} title={t("open")} aria-expanded={open} onClick={() => setOpen(true)}>
        <CircleHelp size={20} />
      </Button>
      <Drawer open={open} onOpenChange={setOpen} title={t("title")} variant="panel" bare>
        {open && <Panel workspace={workspace} projects={projects} onClose={() => setOpen(false)} />}
      </Drawer>
    </>
  );
}

/** เมนู ☰ บนมือถือ: ไปหน้าศูนย์ช่วยเหลือเต็มจอ (X1 มือถือ) */
export function HelpMenuLink({ ws, onNavigate }: { ws: string; onNavigate?: () => void }) {
  const t = useTranslations("help.panel");
  const router = useRouter();
  return (
    <button
      type="button"
      className="nav-link"
      onClick={() => {
        onNavigate?.();
        router.push(`/work/${encodeURIComponent(ws)}/help`);
      }}
    >
      <CircleHelp size={18} />
      {t("menu")}
    </button>
  );
}
