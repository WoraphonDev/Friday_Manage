"use client";

import { useContext, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Download, Trash2 } from "lucide-react";
import { Button, buttonVariants, YearFormatContext, useToast } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { formatDate, localeNumberFormat } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import {
  deletedExportUrl, fetchDeletedExports, fetchDeletedInfo, fetchDeletedWorkspaces, requestDeletedExport, restoreWorkspace, trashKeys,
} from "./api";
import { formatBytes, roleText } from "./format";
import type { DeletedWorkspaceInfo } from "./types";
import styles from "./trash.module.css";

/**
 * Workspace นี้อยู่ในระยะผ่อนผันหลังลบหรือไม่ · shell เรียกเมื่อ slug ไม่อยู่ใน `me/workspaces`
 * 404 = ไม่มีหรือไม่ได้เป็นสมาชิก (แสดง "ไม่พบ" ตามเดิม)
 */
export function useDeletedWorkspace(ws: string, enabled: boolean) {
  return useQuery({ queryKey: trashKeys.deletedInfo(ws), queryFn: () => fetchDeletedInfo(ws), enabled, retry: false });
}

/** Z5 · แสดงแทนทุกหน้าของ Workspace ที่ถูกลบ · Owner กู้คืน / ส่งออกได้ · สมาชิกเห็นช่องทางติดต่อ Owner */
export function DeletedWorkspaceScreen({ ws, info, otherHref }: { ws: string; info: DeletedWorkspaceInfo; /** Workspace อื่นที่ใช้งานได้ (ไม่มี = สร้าง Workspace) */ otherHref: string }) {
  const t = useTranslations("trash.dw");
  const tr = useTranslations("trash");
  const year = useContext(YearFormatContext);
  const toast = useToast();
  const cache = useQueryClient();
  const [pending, setPending] = useState(false);
  const owner = info.myRole === "owner";
  const at = formatDate(info.deletedAt, year, true);
  const purge = formatDate(info.purgeAfter, year, true);
  const by = info.deletedBy ? `${info.deletedBy.displayName}${roleText(tr, info.deletedBy.role)}` : null;
  const expired = !info.can.restore && owner;
  const num = (n: number) => localeNumberFormat().format(n);
  const bold = { b: (chunks: React.ReactNode) => <b>{chunks}</b> };

  async function restore() {
    setPending(true);
    try {
      await restoreWorkspace(ws);
      toast({ message: t("restored", { name: info.name }) });
      // Workspace กลับมาอยู่ใน me/workspaces → shell แสดงหน้าปกติเอง
      await Promise.all([
        cache.invalidateQueries({ queryKey: queryKeys.workspaces }),
        cache.invalidateQueries({ queryKey: trashKeys.deletedWorkspaces }),
      ]);
      cache.removeQueries({ queryKey: trashKeys.deletedInfo(ws) });
    } catch (e) {
      toast({ tone: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.dwBody}>
      <section className={styles.dw} aria-labelledby="dw-title">
        <span className={styles.dwIcon} aria-hidden="true">
          <Trash2 size={24} />
        </span>
        <h1 id="dw-title">{t("title", { name: info.name })}</h1>
        {owner ? (
          <>
            <p>{expired ? t("expired") : by ? t.rich("by", { by, at, purge, days: info.daysLeft, ...bold }) : t.rich("byUnknown", { at, purge, days: info.daysLeft, ...bold })}</p>
            <div className={styles.dwFacts}>
              <div className={styles.dwFact}>
                <span>{t("projects")}</span>
                <span>{t("projectsValue", { projects: num(info.counts.projects), issues: num(info.counts.issues), size: formatBytes(info.counts.storageBytes) })}</span>
              </div>
              <div className={styles.dwFact}>
                <span>{t("members")}</span>
                <span>{t("membersValue", { n: num(info.counts.members) })}</span>
              </div>
              <div className={styles.dwFact}>
                <span>{t("plan")}</span>
                <span>{info.plan.code === "free" || info.plan.status === "canceled" ? t("planCanceled") : t("planOther", { plan: info.plan.name })}</span>
              </div>
            </div>
            <div className={styles.dwActions}>
              {info.can.export && <ExportButton ws={ws} />}
              {info.can.restore && (
                <Button variant="primary" disabled={pending} onClick={() => void restore()}>
                  {t("restore")}
                </Button>
              )}
            </div>
            {info.can.restore && (
              <p className={styles.dwNote}>
                {t("pdpa", { days: info.daysLeft })} <Link href="/legal/privacy">{t("pdpaLink")}</Link>
              </p>
            )}
          </>
        ) : (
          <div className={styles.dwMember}>
            <p>
              {t("memberText", {
                at,
                purge,
                owners: info.owners.map((o) => `${o.displayName} · ${o.email}`).join(", ") || "—",
              })}
            </p>
            <Link className={buttonVariants({ size: "small" })} href={otherHref}>
              {t("otherWorkspaces")}
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}

/** ส่งออกข้อมูลก่อนลบถาวร (A31 แบบระหว่างรอลบ) · ถามสถานะทุก 3 วินาทีจนพร้อม */
function ExportButton({ ws }: { ws: string }) {
  const t = useTranslations("trash.dw");
  const toast = useToast();
  const cache = useQueryClient();
  const [pending, setPending] = useState(false);
  const exports = useQuery({
    queryKey: trashKeys.deletedExports(ws),
    queryFn: () => fetchDeletedExports(ws),
    refetchInterval: (q) => (q.state.data?.items[0] && ["queued", "running"].includes(q.state.data.items[0].status) ? 3000 : false),
  });
  const latest = exports.data?.items[0];
  async function start() {
    setPending(true);
    try {
      await requestDeletedExport(ws);
      await cache.invalidateQueries({ queryKey: trashKeys.deletedExports(ws) });
    } catch (e) {
      toast({ tone: "error", message: e instanceof ApiError || e instanceof Error ? e.message : String(e) });
    } finally {
      setPending(false);
    }
  }
  const working = latest && (latest.status === "queued" || latest.status === "running");
  return (
    <>
      {latest?.status === "ready" ? (
        <a className={buttonVariants({})} href={deletedExportUrl(ws, latest.id)} download>
          <Download size={16} aria-hidden="true" />
          {t("download")}
        </a>
      ) : (
        <Button disabled={pending || !!working} onClick={() => void start()}>
          {working ? t("exporting") : t("export")}
        </Button>
      )}
      {latest?.status === "ready" && <span className={styles.dwNote} role="status">{t("exportReady")}</span>}
      {latest?.status === "failed" && <span className={styles.dwNote} role="status">{t("exportFailed")}</span>}
    </>
  );
}

/**
 * ส่วน "ลบไว้ · กู้คืนได้" ในตัวสลับ Workspace (Q1) · มีเฉพาะ Workspace ที่ผู้ใช้เป็น Owner (`GET workspaces/deleted`)
 * ไม่มีรายการ = ไม่แสดงอะไร
 */
export function DeletedWorkspacesSection({ onNavigate, itemClassName, logoClassName, labelClassName }: { onNavigate?: () => void; itemClassName: string; logoClassName: string; labelClassName: string }) {
  const t = useTranslations("trash.switcher");
  const q = useQuery({ queryKey: trashKeys.deletedWorkspaces, queryFn: fetchDeletedWorkspaces, retry: false, staleTime: 60_000 });
  const items = q.data?.items ?? [];
  if (!items.length) return null;
  return (
    <>
      <div className={labelClassName}>{t("deleted")}</div>
      <nav aria-label={t("deleted")}>
        {items.map((w) => (
          <Link key={w.slug} className={`${itemClassName} ${styles.wsDeleted}`} href={`/work/${encodeURIComponent(w.slug)}`} onClick={onNavigate}>
            <span className={logoClassName}>{w.name.slice(0, 1)}</span>
            <span className="workspace-item-text">
              <strong>{w.name}</strong>
            </span>
            <span className={styles.wsDays}>{t("days", { n: w.daysLeft })}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
