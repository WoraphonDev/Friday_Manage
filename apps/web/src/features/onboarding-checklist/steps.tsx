"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Check } from "lucide-react";
import { buttonVariants, useToast } from "@/components/ui";
import { cn } from "@/lib/utils";
import { type Checklist, type OnboardingStep, useOnboardingAction, useTaskOpened } from "./use-onboarding";
import styles from "./onboarding-checklist.module.css";

export const NS = "onboarding-checklist";
const DAY = 86_400_000;
export const href = (ws: string, path: string) => `/work/${encodeURIComponent(ws)}/${path}`;

// ---------------------------------------------------------------------------
// แถวของขั้น (ใช้ทั้งการ์ด Popover และ Bottom sheet)
// ---------------------------------------------------------------------------

/** ข้อความบรรทัดรองของขั้น: ตัวเลขประกอบ · ชื่อโปรเจกต์ · คำเชิญค้าง · ทำเมื่อไร */
export function useStepText() {
  const t = useTranslations(NS);
  const when = (iso: string | null) => {
    if (!iso) return t("stepDone");
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
    return days <= 0 ? t("doneToday") : days === 1 ? t("doneYesterday") : t("doneDaysAgo", { days });
  };
  const sub = (s: OnboardingStep, mobile = false): string => {
    const d = s.detail ?? {};
    const k = `steps.${s.key}`;
    switch (s.key) {
      case "first_project":
        return s.done && d.projectName ? t(`${k}.done`, { project: String(d.projectName) }) : t(`${k}.todo`);
      case "issues":
        return t(`${k}.count`, { current: s.current, target: s.target });
      case "team": {
        const count = t(`${k}.count`, { current: s.current, target: s.target });
        const pending = (d.pendingInvites as string[] | undefined) ?? [];
        const total = Number(d.pendingCount ?? 0);
        if (s.done || !total) return count;
        const first = pending[0] ? t(mobile ? `${k}.pendingShort` : `${k}.pending`, { email: pending[0] }) : "";
        if (mobile) return first || t(`${k}.pendingMore`, { count: total });
        return [count, first, total > 1 ? t(`${k}.pendingMore`, { count: total }) : ""].filter(Boolean).join(" · ");
      }
      case "open_assigned":
        if (s.done) return when(s.doneAt);
        return d.issueKey ? t(`${k}.issue`, { key: String(d.issueKey), title: String(d.title ?? "") }) : t(`${k}.todo`);
      default:
        return s.done ? when(s.doneAt) : t(`${k}.todo`);
    }
  };
  /** หัวข้อของขั้นถัดไปในการ์ดย่อบนมือถือ (บอกจำนวนที่เหลือ) */
  const nextTitle = (s: OnboardingStep) => {
    const left = Math.max(1, s.target - s.current);
    if (s.key === "team" || s.key === "issues") return t(`steps.${s.key}.nextTitle`, { left });
    return t(`steps.${s.key}.title`);
  };
  return { sub, nextTitle };
}

function ActionButton({ ws, step, scope, primary, onNavigate }: { ws: string; step: OnboardingStep; scope: Checklist["scope"]; primary: boolean; onNavigate?: () => void }) {
  const t = useTranslations(NS);
  const opened = useTaskOpened(ws);
  if (!step.action || step.done) return null;
  const label = step.action.kind === "notify_settings" && scope === "member" ? t("actions.notify_settings_member") : t(`actions.${step.action.kind}`);
  const issueKey = step.action.kind === "open_issue" ? (step.detail?.issueKey as string | undefined) : undefined;
  return (
    <Link
      className={cn(buttonVariants({ variant: primary ? "primary" : "secondary", size: "small" }), styles.action)}
      href={href(ws, step.action.path)}
      onClick={() => {
        if (issueKey) opened.mutate(issueKey);
        onNavigate?.();
      }}
    >
      {label}
    </Link>
  );
}

function StepRow({ ws, step, index, data, compact = false, onNavigate }: { ws: string; step: OnboardingStep; index: number; data: Checklist; compact?: boolean; onNavigate?: () => void }) {
  const t = useTranslations(NS);
  const { sub } = useStepText();
  const isNext = data.next === step.key;
  // แบบย่อ (Popover / Bottom sheet) ขั้นที่เสร็จแล้วแสดงแค่หัวข้อ
  const showSub = !(compact && step.done);
  return (
    <li className={cn(styles.step, isNext && styles.stepNext, step.done && styles.stepDone)} aria-current={isNext ? "step" : undefined}>
      <span className={cn(styles.mark, step.done ? styles.markDone : isNext ? styles.markNext : styles.markTodo)} aria-hidden="true">
        {step.done && <Check size={13} strokeWidth={3} />}
      </span>
      <span className={styles.stepText}>
        <b className={styles.stepTitle}>
          <span className="sr-only">{step.done ? t("stepDone") : isNext ? t("stepNext") : t("stepTodo")}: </span>
          {index + 1}. {t(`steps.${step.key}.title`)}
        </b>
        {showSub && <span className={styles.stepSub}>{sub(step)}</span>}
      </span>
      <ActionButton ws={ws} step={step} scope={data.scope} primary={isNext} onNavigate={onNavigate} />
    </li>
  );
}

export function StepList({ ws, data, compact, onNavigate }: { ws: string; data: Checklist; compact?: boolean; onNavigate?: () => void }) {
  return (
    <ol className={cn(styles.list, compact && styles.listCompact)}>
      {data.steps.map((s, i) => (
        <StepRow key={s.key} ws={ws} step={s} index={i} data={data} compact={compact} onNavigate={onNavigate} />
      ))}
    </ol>
  );
}

export function ProgressBar({ done, total, label }: { done: number; total: number; label: string }) {
  return (
    <span className={styles.bar} role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={label}>
      <span style={{ width: `${Math.round((done * 100) / Math.max(total, 1))}%` }} />
    </span>
  );
}

export function useHide(ws: string) {
  const t = useTranslations(NS);
  const toast = useToast();
  const action = useOnboardingAction(ws);
  return (what: "hide" | "show" | "never") =>
    action.mutate(what, {
      onSuccess: () => {
        if (what === "hide") toast({ message: t("hidden") });
        if (what === "never") toast({ message: t("neverDone") });
      },
      onError: () => toast({ message: t("actionFailed"), tone: "error" }),
    });
}

export function PopFoot({ data, onPick }: { data: Checklist; onPick: (what: "hide" | "show" | "never") => void }) {
  const t = useTranslations(NS);
  return (
    <div className={styles.popFoot}>
      {data.hidden ? (
        <button type="button" className={styles.linkButton} onClick={() => onPick("show")}>
          {t("showOnHome")}
        </button>
      ) : (
        <span />
      )}
      <button type="button" className={styles.mutedButton} onClick={() => onPick("never")}>
        {t("never")}
      </button>
    </div>
  );
}

