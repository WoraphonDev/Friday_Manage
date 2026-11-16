"use client";

import { useState } from "react";
import Link from "next/link";
import * as RadixDialog from "@radix-ui/react-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button, buttonVariants, useToast } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import styles from "./legal.module.css";

export interface LegalDoc {
  id: string;
  type: string;
  version: string;
  effectiveAt: string;
  summary: string | null;
  /** false = แจ้งให้ทราบอย่างเดียว (ไม่ต้องกดยอมรับ) · API รุ่นเก่าไม่ส่ง = ถือว่าต้องยอมรับ */
  requiresAcceptance?: boolean;
}
export interface LegalItem extends LegalDoc {
  accepted: boolean;
  acceptedAt?: string | null;
  /** ฉบับแจ้งให้ทราบ: แสดงแบนเนอร์ถึงเวลานี้ (วันมีผล + 14 วัน) */
  noticeUntil?: string | null;
}
export interface MyLegal {
  items: LegalItem[];
  /** ฉบับถัดไปที่ตั้งเวลาไว้และเปิดแบนเนอร์ก่อนวันมีผล */
  upcoming?: LegalDoc[];
}

/** เอกสารที่ต้องยอมรับในแอป · ชนิดอื่น (คุกกี้ ผู้ให้บริการช่วง) แจ้งด้วยแบนเนอร์อย่างเดียว */
const ACCEPT_TYPES = ["terms", "privacy", "dpa"];
const NOTICE_DAYS = 14;
const DAY = 86_400_000;

const dismissKey = (id: string) => `fm_legal_dismissed:${id}`;
function isDismissed(id: string) {
  try {
    return localStorage.getItem(dismissKey(id)) === "1";
  } catch {
    return false;
  }
}
function dismiss(id: string) {
  try {
    localStorage.setItem(dismissKey(id), "1");
  } catch {
    /* จำไม่ได้ก็ซ่อนแค่ในหน้านี้ */
  }
}

/** สรุปสิ่งที่เปลี่ยนเป็นรายข้อ (ทีม Friday เขียนคั่นด้วย " · " หรือขึ้นบรรทัดใหม่) */
export const summaryPoints = (summary: string | null) =>
  (summary ?? "")
    .split(/\s·\s|\n/)
    .map((x) => x.trim())
    .filter(Boolean);

const bkkDay = (d: Date) => new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
const needsAcceptance = (d: LegalItem) => d.requiresAcceptance !== false && ACCEPT_TYPES.includes(d.type);

/**
 * แจ้งเอกสารกฎหมายฉบับใหม่ในแอป (O42 · H16–H17) · ผู้ใช้ทุกคนใน Workspace (ไม่ใช่แค่ Owner / Admin)
 * - ก่อนวันมีผล: แบนเนอร์ของฉบับที่ตั้งเวลาไว้ (ปิดได้ จำในเบราว์เซอร์)
 * - ฉบับแจ้งให้ทราบที่มีผลแล้ว: แบนเนอร์ 14 วันหลังมีผล
 * - ฉบับที่ต้องยอมรับและมีผลแล้ว: หน้าต่างยอมรับ บันทึก `POST me/legal-acceptances` ในนาม Workspace
 */
export function LegalNotices({ ws }: { ws: string }) {
  const t = useTranslations("saas-pages.banners.legal");
  const tl = useTranslations("saas-pages.legal.types");
  const cache = useQueryClient();
  const toast = useToast();
  const [, rerender] = useState(0);
  const [busy, setBusy] = useState(false);
  const mine = useQuery({ queryKey: ["legal-acceptances"], queryFn: () => api.get<MyLegal>("/me/legal-acceptances"), retry: false, staleTime: 300_000 });
  const data = mine.data;
  if (!data) return null;
  const now = Date.now();
  const name = (type: string) => tl(type as "terms");

  const pending = (data.items ?? []).filter((d) => !d.accepted && needsAcceptance(d));
  const notices = (data.items ?? []).filter((d) => {
    if (needsAcceptance(d) || isDismissed(d.id)) return false;
    const until = d.noticeUntil ? Date.parse(d.noticeUntil) : Date.parse(d.effectiveAt) + NOTICE_DAYS * DAY;
    return until > now;
  });
  const upcoming = (data.upcoming ?? []).filter((d) => !isDismissed(d.id) && Date.parse(d.effectiveAt) > now);
  const current = pending[0];

  const close = (id: string) => {
    dismiss(id);
    rerender((n) => n + 1);
  };
  const brief = (summary: string | null) => {
    const p = summaryPoints(summary);
    return p.length > 1 ? `${p[0]} ${t("more", { count: p.length - 1 })}` : (p[0] ?? "");
  };
  async function accept(doc: LegalItem) {
    setBusy(true);
    try {
      await api.post("/me/legal-acceptances", { documentId: doc.id, workspace: ws });
      await cache.invalidateQueries({ queryKey: ["legal-acceptances"] });
      toast({ message: t("accepted") });
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const banner = (d: LegalDoc, title: string, gray = false) => (
    <div key={d.id} className={cn(styles.banner, gray && styles.gray)} role="status">
      <b>{title}</b>
      <span>{brief(d.summary)}</span>
      <span className={styles.row}>
        <Link className={buttonVariants({ size: "small" })} href={`/legal/${d.type}`} target="_blank">
          {t("changes")}
        </Link>
        <Button size="small" onClick={() => close(d.id)}>
          {t("dismiss")}
        </Button>
      </span>
    </div>
  );

  return (
    <>
      {upcoming.map((d) => banner(d, t("upcomingTitle", { name: name(d.type), date: formatDate(d.effectiveAt, "BE", true) })))}
      {notices.map((d) => banner(d, t("noticeTitle", { name: name(d.type), date: formatDate(d.effectiveAt, "BE", true) }), true))}
      {current && (
        <RadixDialog.Root open>
          <RadixDialog.Portal>
            <RadixDialog.Overlay className="overlay" />
            {/* ต้องตอบก่อนใช้งานต่อ: ไม่มีปุ่มปิด และกด Esc / คลิกนอกหน้าต่างไม่ปิด */}
            <RadixDialog.Content className="dialog" onEscapeKeyDown={(e) => e.preventDefault()} onPointerDownOutside={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}>
              <div className={styles.heading}>
                <RadixDialog.Title>{t("modalTitle", { name: name(current.type), version: current.version })}</RadixDialog.Title>
                <RadixDialog.Description className="muted">
                  {bkkDay(new Date(current.effectiveAt)) === bkkDay(new Date())
                    ? t("effectiveToday", { date: formatDate(current.effectiveAt, "BE", true) })
                    : t("effectiveSince", { date: formatDate(current.effectiveAt, "BE", true) })}
                </RadixDialog.Description>
              </div>
              {summaryPoints(current.summary).length > 0 && (
                <ul className={styles.points}>
                  {summaryPoints(current.summary).map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              <Link href={`/legal/${current.type}`} target="_blank">
                {t("readFull")}
              </Link>
              <div className={styles.foot}>
                <span className={styles.note}>{t("declineNote")}</span>
                <Button variant="primary" disabled={busy} onClick={() => accept(current)}>
                  {t("acceptContinue")}
                </Button>
              </div>
            </RadixDialog.Content>
          </RadixDialog.Portal>
        </RadixDialog.Root>
      )}
    </>
  );
}
