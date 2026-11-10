"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Ban, Lock } from "lucide-react";
import { buttonVariants } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import styles from "./suspension.module.css";

export interface Suspension {
  mode: "read_only" | "full";
  message: string | null;
}
type Role = "owner" | "admin" | "member" | "guest";
/** อีเมลทีมช่วยเหลือ (ตั้งตอน build) · ไม่ตั้ง = ให้ตอบกลับอีเมลแจ้งระงับแทน */
const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "";

/** ข้อมูล Workspace (`GET w/{ws}`) · ถูกระงับแบบปิดทั้งหมด สมาชิกที่ไม่ใช่ Owner ได้ 403 workspace_suspended */
export function useSuspension(ws: string, enabled = true) {
  const q = useQuery({
    queryKey: ["workspace", ws, "info"],
    queryFn: () => api.get<{ suspension: Suspension | null }>(`/w/${encodeURIComponent(ws)}`),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
  const err = q.error instanceof ApiError && q.error.code === "workspace_suspended" ? q.error : null;
  const suspension: Suspension | null = err ? { mode: "full", message: (err.details.message as string | null) ?? null } : (q.data?.suspension ?? null);
  return { suspension, pending: q.isPending && enabled };
}

/** หน้าที่ Owner ยังเปิดได้ตอนปิดทั้งหมด (ชำระเงิน) · API อนุญาต billing / usage ให้หน้านี้ */
const OWNER_PATHS = /\/billing(\/|$)/;

/** ถูกระงับแบบปิดทั้งหมด → แทนเนื้อหาทั้งหน้า (ยกเว้น Owner ในหน้าชำระเงิน) */
export function isBlocked(s: Suspension | null, role: Role | undefined, pathname: string) {
  if (s?.mode !== "full") return false;
  return !(role === "owner" && OWNER_PATHS.test(pathname));
}

/** แถบเตือนตอนอ่านอย่างเดียว (C6) · ข้อความจากทีม Friday · Owner / Admin มีลิงก์ชำระเงิน */
export function SuspensionBanner({ ws, suspension, role }: { ws: string; suspension: Suspension | null; role: Role }) {
  const t = useTranslations("suspension");
  if (suspension?.mode !== "read_only") return null;
  return (
    <div className={styles.banner} role="status">
      <Lock size={16} aria-hidden="true" />
      <b>{t("readOnlyTitle")}</b>
      <span>{suspension.message ?? t("readOnlyDefault")}</span>
      {(role === "owner" || role === "admin") && (
        <Link className={buttonVariants({ variant: "primary", size: "small" })} href={`/work/${encodeURIComponent(ws)}/billing`}>
          {t("pay")}
        </Link>
      )}
    </div>
  );
}

/** หน้าแทนเนื้อหาตอนปิดทั้งหมด: Owner เห็นช่องทางติดต่อทีม + ชำระเงิน · คนอื่นให้ติดต่อ Owner */
export function SuspendedScreen({ ws, suspension, role }: { ws: string; suspension: Suspension; role: Role | undefined }) {
  const t = useTranslations("suspension");
  const owner = role === "owner";
  const pathname = usePathname();
  return (
    <div className={styles.screen}>
      <section className={styles.card} aria-labelledby="suspended-title">
        <span className={styles.icon} aria-hidden="true">
          <Ban size={22} />
        </span>
        <h1 id="suspended-title">{t("fullTitle")}</h1>
        {suspension.message && <p className={styles.message}>{suspension.message}</p>}
        <p className={styles.muted}>{owner ? t("fullOwner") : t("fullMember")}</p>
        <p className={styles.muted}>{t("dataSafe")}</p>
        {owner && (
          <div className={styles.actions}>
            {SUPPORT_EMAIL && (
              <a className={buttonVariants({ variant: "primary" })} href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(t("mailSubject", { ws }))}`}>
                {t("contact")}
              </a>
            )}
            {!pathname.includes("/billing") && (
              <Link className={buttonVariants({ variant: "secondary" })} href={`/work/${encodeURIComponent(ws)}/billing`}>
                {t("billing")}
              </Link>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
