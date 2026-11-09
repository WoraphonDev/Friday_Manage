"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import type { Permissions } from "@/lib/types";
import { ExportPanel } from "../../../app/work/[ws]/import/_components/export-panel";
import { ImportWizard } from "../../../app/work/[ws]/import/_components/import-wizard";
import { PlanChangesView } from "../../../app/work/[ws]/p/[key]/plan-changes/_components/plan-changes-view";
import styles from "./plan-io.module.css";

/**
 * Import / Export ของโปรเจกต์ (ผู้ใช้ตัดสิน 2026-11-09)
 * อยู่ 2 ที่: Popup จากปุ่มในแท็บ Table และเมนูในแท็บ Settings · เนื้อหาชุดเดียวกัน
 * สิทธิ์: อัปเดตแผนจาก Excel / การแก้ไขแผน = project.baseline · Export = ทุกคนที่ดูโปรเจกต์ได้ (ไม่ใช่ Guest Viewer)
 */
export const PLAN_IO_SECTIONS = ["import", "export", "changes"] as const;
export type PlanIoSection = (typeof PLAN_IO_SECTIONS)[number];
export const isPlanIoSection = (v: string | null | undefined): v is PlanIoSection => !!v && (PLAN_IO_SECTIONS as readonly string[]).includes(v);

/** เมนูที่คนนี้ใช้ได้ · ยังโหลดสิทธิ์ไม่เสร็จ = ว่าง */
export function usePlanIoSections(ws: string, projectKey: string): PlanIoSection[] {
  const perms = useQuery({
    queryKey: queryKeys.permissions(ws, projectKey),
    queryFn: () => api.get<Permissions>(`/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projectKey)}/my-permissions`),
  });
  if (!perms.data || perms.data.guestViewer) return [];
  const baseline = perms.data.permissions.includes("project.baseline");
  return PLAN_IO_SECTIONS.filter((s) => s === "export" || baseline);
}

export function PlanIoContent({ ws, projectKey, section, changesHref }: { ws: string; projectKey: string; section: PlanIoSection; changesHref?: string }) {
  if (section === "export") return <ExportPanel ws={ws} projectKey={projectKey} />;
  if (section === "changes") return <PlanChangesView ws={ws} projectKey={projectKey} embedded />;
  return <ImportWizard ws={ws} projectKey={projectKey} changesHref={changesHref} />;
}

/**
 * Popup ในแท็บ Table · เปิด / ปิด / เปลี่ยนเมนูผ่าน ?io= ใน URL
 * (ลิงก์จาก Dashboard / Reports / ข้อความหลังนำเข้า เปิดเมนูที่ต้องการได้ และกดงานในรายการแก้ไขแผนแล้ว Drawer งานเปิดแทน)
 */
export function PlanIoDialog({ ws, projectKey }: { ws: string; projectKey: string }) {
  const t = useTranslations("import-plan-changes.import");
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const sections = usePlanIoSections(ws, projectKey);
  const wanted = search.get("io");
  if (!isPlanIoSection(wanted) || !sections.length) return null;
  // ขอเมนูที่ไม่มีสิทธิ์ (เช่น สมาชิกทั่วไปกดลิงก์การแก้ไขแผน) → เปิดเมนูแรกที่ใช้ได้
  const section = sections.includes(wanted) ? wanted : sections[0];
  const go = (next: PlanIoSection | null) => {
    const params = new URLSearchParams(search);
    if (next) params.set("io", next);
    else params.delete("io");
    router.replace(`${pathname}${params.size ? `?${params}` : ""}`, { scroll: false });
  };
  const changesHref = `${pathname}?io=changes`;

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) go(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className={styles.dialog} aria-describedby={undefined}>
          <header className={styles.head}>
            <Dialog.Title className={styles.title}>{t("dialogTitle")}</Dialog.Title>
            <Dialog.Close className={styles.close} aria-label={t("close")}><X size={18} aria-hidden="true" /></Dialog.Close>
          </header>
          <div className={styles.body}>
            <nav className={styles.nav} aria-label={t("sections")}>
              {sections.map((s) => (
                <button key={s} type="button" className={`${styles.item} ${section === s ? styles.on : ""}`} aria-current={section === s ? "page" : undefined} onClick={() => go(s)}>
                  {t(`section__${s}`)}
                </button>
              ))}
              <p className={styles.note}>{t("sectionNote")}</p>
            </nav>
            <div className={styles.main}>
              <PlanIoContent key={section} ws={ws} projectKey={projectKey} section={section} changesHref={changesHref} />
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
