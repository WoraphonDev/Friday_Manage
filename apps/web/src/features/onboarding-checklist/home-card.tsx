"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as RadixDialog from "@radix-ui/react-dialog";
import { useTranslations } from "next-intl";
import { BookOpen, FolderOpen, X } from "lucide-react";
import { Button, buttonVariants, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api } from "@/lib/api";
import { useIsMobile } from "@/lib/use-mobile";
import { cn } from "@/lib/utils";
import { href, NS, PopFoot, ProgressBar, StepList, useHide, useStepText } from "./steps";
import { type Checklist, showsCard, useOnboarding, useOnboardingAction } from "./use-onboarding";
import styles from "./onboarding-checklist.module.css";

type Role = "owner" | "admin" | "member" | "guest";

// แยกจาก index.tsx เพราะใช้ useWorkspace ของ shell (shell import index.tsx · ไม่ให้ import วนกัน)
// ---------------------------------------------------------------------------
// การ์ดบนสุดของ Home (V1 · V3 · V4 · มือถือ)
// ---------------------------------------------------------------------------

/**
 * การ์ดเริ่มต้นใช้งานบน Home (W25) · Owner / Admin เห็น 6 ขั้นของ Workspace · Member เห็น 3 ขั้นส่วนตัว · Guest ไม่เห็น
 * กำลังโหลด / Error = ไม่แสดงอะไร (ไม่ดันเนื้อหา Home) · มือถือแสดงการ์ดย่อเฉพาะขั้นถัดไป + Bottom sheet
 */
export function OnboardingHomeCard({ ws, role }: { ws: string; role: Role }) {
  const { data } = useOnboarding(ws, role);
  const mobile = useIsMobile();
  const seen = useOnboardingAction(ws);
  // การ์ดครบแล้ว (V4) แสดงครั้งเดียว: บันทึกว่าเห็นแล้วตั้งแต่แสดง แต่ยังค้างไว้ในหน้านี้จนกดปิดหรือออกจากหน้า
  const [stickyComplete, setStickyComplete] = useState<Checklist | null>(null);
  const [closed, setClosed] = useState(false);
  const recorded = useRef(false);
  const completeNow = !!data && data.completed && !data.completionSeen && showsCard(data);
  useEffect(() => {
    if (!completeNow || recorded.current) return;
    recorded.current = true;
    setStickyComplete(data!);
    seen.mutate("complete-seen");
  }, [completeNow, data, seen]);
  if (closed) return null;
  if (stickyComplete) return <CompleteCard ws={ws} data={stickyComplete} onClose={() => setClosed(true)} />;
  if (!data || !showsCard(data) || data.completed) return null;
  return mobile ? <MobileCard ws={ws} data={data} /> : <DesktopCard ws={ws} data={data} />;
}

function CardHead({ data, titleId }: { data: Checklist; titleId: string }) {
  const t = useTranslations(NS);
  const { workspace } = useWorkspace();
  const member = data.scope === "member";
  return (
    <div>
      <h2 className={styles.title} id={titleId}>
        {member ? t("memberTitle", { name: workspace.name }) : t("title", { name: workspace.name })}
      </h2>
      <p className={styles.subtitle}>
        {member
          ? data.invitedBy
            ? t("memberInvitedBy", { name: data.invitedBy.name, total: data.total })
            : t("memberSubtitle", { total: data.total })
          : t("subtitle")}
      </p>
    </div>
  );
}

function DesktopCard({ ws, data }: { ws: string; data: Checklist }) {
  const t = useTranslations(NS);
  const hide = useHide(ws);
  const titleId = useId();
  return (
    <section className={styles.card} aria-labelledby={titleId}>
      <header className={styles.head}>
        <CardHead data={data} titleId={titleId} />
        <div className={styles.meter}>
          <b>{t("progress", { done: data.doneCount, total: data.total })}</b>
          <ProgressBar done={data.doneCount} total={data.total} label={t("progressLabel", { done: data.doneCount, total: data.total })} />
          <Button size="small" onClick={() => hide("hide")}>
            {t("hide")}
          </Button>
        </div>
      </header>
      <div className={cn(styles.grid, data.scope === "member" && styles.gridSingle)}>
        <StepList ws={ws} data={data} />
        {data.scope === "workspace" && <WhyTeam ws={ws} />}
      </div>
    </section>
  );
}

/** กล่อง "ทำไมต้องชวนทีม" · คู่มือ (ศูนย์ช่วยเหลือ W26) ยังไม่มีจึงซ่อน · ถาม Support แสดงเมื่อตั้งอีเมลไว้ */
function WhyTeam({ ws }: { ws: string }) {
  const t = useTranslations(NS);
  const toast = useToast();
  const router = useRouter();
  const { projects } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const sample = projects.find((p) => p.name.endsWith("(ตัวอย่าง)"));
  async function openSample() {
    if (sample) return router.push(href(ws, `p/${encodeURIComponent(sample.key)}`));
    setBusy(true);
    try {
      const p = await api.post<{ key: string }>(`/w/${encodeURIComponent(ws)}/projects/sample`, {});
      router.push(href(ws, `p/${encodeURIComponent(p.key)}`));
    } catch {
      toast({ message: t("why.sampleFailed"), tone: "error" });
      setBusy(false);
    }
  }
  return (
    <aside className={styles.why} aria-label={t("why.title")}>
      <b>{t("why.title")}</b>
      <p>{t("why.body")}</p>
      {/* ศูนย์ช่วยเหลือ (W26) มาทีหลังงานนี้: คู่มือเปิดหมวดเริ่มต้นใช้งาน · ถาม Support ใช้ฟอร์มในแอปแทน mailto */}
      <Link className={styles.linkButton} href={href(ws, "help?category=getting-started")}>
        <BookOpen size={14} aria-hidden="true" /> {t("why.guide")}
      </Link>
      <button type="button" className={styles.linkButton} onClick={() => void openSample()} disabled={busy}>
        <FolderOpen size={14} aria-hidden="true" /> {t("why.sample")}
      </button>
      <p className={styles.small}>
        {t("why.stuck")}{" "}
        <Link href={href(ws, `help/contact?${new URLSearchParams({ subject: t("why.mailSubject", { ws }) })}`)}>{t("why.askSupport")}</Link>
      </p>
    </aside>
  );
}

function MobileCard({ ws, data }: { ws: string; data: Checklist }) {
  const t = useTranslations(NS);
  const { sub, nextTitle } = useStepText();
  const [open, setOpen] = useState(false);
  const next = data.steps.find((s) => s.key === data.next);
  const titleId = useId();
  return (
    <section className={cn(styles.card, styles.mobileCard)} aria-labelledby={titleId}>
      <div className={styles.mobileHead}>
        <h2 className={styles.mobileTitle} id={titleId}>
          {t("short")}
        </h2>
        <b>{t("progress", { done: data.doneCount, total: data.total })}</b>
      </div>
      <ProgressBar done={data.doneCount} total={data.total} label={t("progressLabel", { done: data.doneCount, total: data.total })} />
      {next && (
        <div className={styles.mobileNext}>
          <span className={cn(styles.mark, styles.markNext)} aria-hidden="true" />
          <span className={styles.stepText}>
            <b className={styles.stepTitle}>{nextTitle(next)}</b>
            <span className={styles.stepSub}>{sub(next, true)}</span>
          </span>
        </div>
      )}
      <div className={styles.mobileActions}>
        {next?.action && (
          <Link className={cn(buttonVariants({ variant: "primary" }), styles.grow)} href={href(ws, next.action.path)}>
            {t(`actions.${next.action.kind === "notify_settings" && data.scope === "member" ? "notify_settings_member" : next.action.kind}`)}
          </Link>
        )}
        <Button onClick={() => setOpen(true)}>{t("viewAll")}</Button>
      </div>
      <BottomSheet open={open} onOpenChange={setOpen} ws={ws} data={data} />
    </section>
  );
}

/** Bottom sheet ของมือถือ: รายการทั้งหมด + ซ่อน / ไม่ต้องแสดงอีก */
function BottomSheet({ open, onOpenChange, ws, data }: { open: boolean; onOpenChange: (o: boolean) => void; ws: string; data: Checklist }) {
  const t = useTranslations(NS);
  const hide = useHide(ws);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="overlay" />
        <RadixDialog.Content className={styles.sheet} aria-describedby={undefined}>
          <span className={styles.grip} aria-hidden="true" />
          <div className={styles.popHead}>
            <RadixDialog.Title className={styles.popTitle}>{t("short")}</RadixDialog.Title>
            <span className={styles.pill}>{t("progress", { done: data.doneCount, total: data.total })}</span>
            <RadixDialog.Close asChild>
              <Button variant="ghost" size="icon" className={styles.sheetClose} aria-label={t("complete.close")}>
                <X size={18} />
              </Button>
            </RadixDialog.Close>
          </div>
          <StepList ws={ws} data={data} compact onNavigate={() => onOpenChange(false)} />
          <PopFoot data={data} onPick={(what) => (hide(what), onOpenChange(false))} />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** การ์ดเขียวเมื่อครบ (V4) · แสดงครั้งเดียว */
function CompleteCard({ ws, data, onClose }: { ws: string; data: Checklist; onClose: () => void }) {
  const t = useTranslations(NS);
  const { projects } = useWorkspace();
  const member = data.scope === "member";
  const project = projects[0];
  return (
    <section className={styles.complete} role="status">
      <span className={styles.logoMark} aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <div className={styles.completeText}>
        <b>{member ? t("complete.memberTitle", { total: data.total }) : t("complete.title", { total: data.total })}</b>
        <span>{member ? t("complete.memberBody") : t("complete.body")}</span>
      </div>
      {!member && project && (
        <Link className={buttonVariants({ size: "small" })} href={href(ws, `p/${encodeURIComponent(project.key)}/gantt`)}>
          {t("complete.gantt")}
        </Link>
      )}
      <Button variant="ghost" size="small" onClick={onClose}>
        {t("complete.close")}
      </Button>
    </section>
  );
}

