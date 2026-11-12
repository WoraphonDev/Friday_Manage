"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import * as Popover from "@radix-ui/react-popover";
import { useTranslations } from "next-intl";
import { ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import { NS, PopFoot, StepList, useHide } from "./steps";
import { showsAccountItem, showsNavButton, useOnboarding } from "./use-onboarding";
import styles from "./onboarding-checklist.module.css";

type Role = "owner" | "admin" | "member" | "guest";

// การ์ดบน Home อยู่ที่ ./home-card (ใช้ useWorkspace ของ shell)
// ---------------------------------------------------------------------------
// ปุ่มท้าย Sidebar (V2) และเมนูบัญชี (V4)
// ---------------------------------------------------------------------------

/**
 * ปุ่ม "เริ่มต้นใช้งาน n/6" ท้าย Sidebar เหนือ Admin Console (V2) · เปิด Popover รายการย่อ
 * อยู่ใน Navigation จึงขึ้นในเมนู ☰ ของมือถือด้วย · `standalone` = ไม่มีส่วนท้ายของ Admin ให้ครอบ (สมาชิก) จึงครอบเอง
 */
export function OnboardingNavButton({ ws, role, standalone = false, onNavigate }: { ws: string; role: Role; standalone?: boolean; onNavigate?: () => void }) {
  const t = useTranslations(NS);
  const { data } = useOnboarding(ws, role);
  const hide = useHide(ws);
  const [open, setOpen] = useState(false);
  if (role === "guest" || !data || !showsNavButton(data)) return null;
  const next = data.steps.find((s) => s.key === data.next);
  const button = (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={cn("nav-link", styles.navButton)} aria-label={t("navButton", { done: data.doneCount, total: data.total })}>
          <ProgressRing done={data.doneCount} total={data.total} />
          <span className={styles.navLabel}>{t("short")}</span>
          <b className={styles.navCount}>
            {data.doneCount}/{data.total}
          </b>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={cn("popover", styles.pop)} side="right" align="end" sideOffset={12} collisionPadding={12} aria-label={t("short")}>
          <div className={styles.popHead}>
            <b className={styles.popTitle}>{t("short")}</b>
            <span className={styles.pill}>{t("progress", { done: data.doneCount, total: data.total })}</span>
            {next && <span className={styles.popNext}>{t("next", { step: t(`steps.${next.key}.short`) })}</span>}
          </div>
          <StepList
            ws={ws}
            data={data}
            compact
            onNavigate={() => {
              setOpen(false);
              onNavigate?.();
            }}
          />
          <PopFoot data={data} onPick={(what) => (hide(what), setOpen(false))} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
  return standalone ? <div className="nav-footer">{button}</div> : button;
}

function ProgressRing({ done, total }: { done: number; total: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg className={styles.ring} width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.5" className={styles.ringTrack} />
      <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.5" className={styles.ringValue} strokeDasharray={c} strokeDashoffset={c * (1 - done / Math.max(total, 1))} transform="rotate(-90 9 9)" strokeLinecap="round" />
    </svg>
  );
}

/**
 * รายการ "เริ่มต้นใช้งาน n/6" ในเมนูบัญชี เมื่อซ่อนการ์ดไว้ (V4) · กดแล้วแสดงบน Home อีกครั้งและไปที่ Home
 * `onSelect` ให้ shell ปิดเมนู
 */
export function OnboardingAccountItem({ ws, role, onSelect }: { ws: string; role: Role; onSelect?: () => void }) {
  const t = useTranslations(NS);
  const router = useRouter();
  const { data } = useOnboarding(ws, role);
  const hide = useHide(ws);
  if (role === "guest" || !data || !showsAccountItem(data)) return null;
  return (
    <button
      type="button"
      className={cn("menu-item menu-icon-item", styles.accountItem)}
      onClick={() => {
        hide("show");
        onSelect?.();
        router.push(`/work/${encodeURIComponent(ws)}`);
      }}
    >
      <ListChecks size={16} aria-hidden="true" />
      {t("short")}
      <span className={styles.pill}>
        {data.doneCount}/{data.total}
      </span>
    </button>
  );
}
