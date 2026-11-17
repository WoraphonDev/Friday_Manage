"use client";

import * as RadixDialog from "@radix-ui/react-dialog";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { CalendarClock, ChevronLeft, Maximize2, X } from "lucide-react";
import { Button } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { IssueInline } from "@/features/issue-drawer/issue-inline";
import { useIsMobile } from "@/lib/use-mobile";
import { DUE_PARAMS, DueReport } from "./due-report";
import styles from "./reports.module.css";

/**
 * รายงานงานที่จะเสร็จแบบ popup จากหน้า Overview (ผู้ใช้ขอ 2026-11-17)
 * สถานะอยู่ใน URL: ?due=1 เปิด popup · ตัวกรองขึ้นต้นด้วย "d" (dfrom, dto, ...) · ?dissue= งานที่เปิดในแผงขวา
 * คัดลอกลิงก์ส่งต่อแล้ว popup เปิดค้างพร้อมตัวกรองเดิม
 */
const PREFIX = "d";
const OPEN = "due";
const ISSUE = "dissue";

function useDueUrl() {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const go = (edit: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(search);
    edit(next);
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  };
  const clear = (next: URLSearchParams) => {
    next.delete(OPEN);
    next.delete(ISSUE);
    for (const k of DUE_PARAMS) next.delete(`${PREFIX}${k}`);
  };
  return { search, go, clear };
}

/** ปุ่มเปิด popup · แสดงเมื่อ Role มีสิทธิ์ project.reports.due */
export function DueButton({ className }: { className?: string }) {
  const t = useTranslations("lead-dashboard-reports.due.popup");
  const { go } = useDueUrl();
  return <button type="button" className={`button button-secondary ${className ?? ""}`} onClick={() => go((next) => next.set(OPEN, "1"))}><CalendarClock size={15} aria-hidden="true" />{t("open")}</button>;
}

export function DuePopup({ ws, projectKey, projectName }: { ws: string; projectKey: string; projectName?: string }) {
  const t = useTranslations("lead-dashboard-reports.due.popup");
  const { me } = useWorkspace();
  const mobile = useIsMobile();
  const { search, go, clear } = useDueUrl();
  const open = search.get(OPEN) === "1";
  const selected = search.get(ISSUE);
  if (!open) return null;

  const close = () => go(clear);
  const openIssue = (key: string) => go((next) => next.set(ISSUE, key));
  const closeIssue = () => go((next) => next.delete(ISSUE));
  // เปิดเต็มหน้า / สร้าง Sub-task: ปิด popup แล้วใช้ Drawer งานเดิมของหน้า
  const toDrawer = (key: string, newSubtask = false) => go((next) => {
    clear(next);
    next.set("issue", key);
    if (newSubtask) { next.set("new", "1"); next.set("parent", key); }
  });
  // หน้าแรกของ popup ไม่ใช่ลิงก์ Drawer · ใช้เป็นค่าสำรองของ DueReport เท่านั้น
  const issueHref = (key: string) => `?${ISSUE}=${encodeURIComponent(key)}`;

  const list = <DueReport ws={ws} projectKey={projectKey} yearFormat={me.yearFormat} issueHref={issueHref} prefix={PREFIX} onOpenIssue={openIssue} selectedKey={selected} />;
  const detail = selected && <div className={styles.dueDetail}>
    <div className={styles.dueDetailBar}>
      {mobile && <Button size="small" variant="ghost" onClick={closeIssue}><ChevronLeft size={15} aria-hidden="true" />{t("back")}</Button>}
      <span className={styles.spacer} />
      <Button size="small" variant="ghost" onClick={() => toDrawer(selected)}><Maximize2 size={14} aria-hidden="true" />{t("openFull")}</Button>
    </div>
    <IssueInline key={selected} ws={ws} projectKey={projectKey} meId={me.id} yearFormat={me.yearFormat} issueKey={selected} onNavigate={openIssue} onClose={closeIssue} onCreateSubtask={(key) => toDrawer(key, true)} />
  </div>;

  return <RadixDialog.Root open onOpenChange={(value) => { if (!value) close(); }}>
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="overlay" />
      <RadixDialog.Content className={styles.duePop} aria-describedby={undefined}
        // กล่องเลือกในแผงงาน (Popover / Select ของ Radix) อยู่นอก popup: คลิกในนั้นต้องไม่ปิด popup
        onPointerDownOutside={(event) => { if ((event.target as Element | null)?.closest?.("[data-radix-popper-content-wrapper], .popover")) event.preventDefault(); }}>
        <div className={styles.duePopHead}>
          <RadixDialog.Title className={styles.duePopTitle}>{t("title")}</RadixDialog.Title>
          {projectName && <span className={styles.muted}>{projectName}</span>}
          <span className={styles.spacer} />
          <RadixDialog.Close asChild><Button size="icon" variant="ghost" aria-label={t("close")}><X size={18} /></Button></RadixDialog.Close>
        </div>
        {/* มือถือ: เปิดงานแล้วรายละเอียดแทนที่รายการ · desktop: ซ้ายรายการ ขวารายละเอียด */}
        <div className={`${styles.duePopBody} ${selected ? styles.duePopSplit : ""}`}>
          {(!mobile || !selected) && <section className={styles.dueList} aria-label={t("listLabel")}>{list}</section>}
          {detail}
        </div>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  </RadixDialog.Root>;
}
