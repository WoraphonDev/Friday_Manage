"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button, Dialog, buttonVariants, useToast } from "@/components/ui";
import { API_PLAN_LIMIT, ApiError, api } from "@/lib/api";
import { cn } from "@/lib/utils";
import styles from "./plan-limits.module.css";
import { bytesToGb, checkoutHref, type PlanLimitDetails, type PublicPlans, type Usage } from "./types";

const PLAN_NAMES: Record<string, string> = { free: "Free", team_s: "Team S", team_m: "Team M", team_l: "Team L", enterprise: "Enterprise" };
const MB = 1024 ** 2;

/** ปุ่ม "ขอให้ Admin อัปเกรด" · ยังไม่มี endpoint ส่งคำขอเข้า Inbox ของ Admin (A29) จึงบอกให้แจ้งเองตรง ๆ */
export function RequestUpgradeButton({ className }: { className?: string }) {
  const t = useTranslations("saas-pages.limits");
  const toast = useToast();
  return (
    <Button variant="primary" className={className} onClick={() => toast({ message: t("requestSent") })}>
      {t("requestUpgrade")}
    </Button>
  );
}

/**
 * Dialog ของ 402 `plan_limit_reached` (หน้า Q2) แยกตาม `details.kind`
 * · Owner / Admin เห็นทางออกและปุ่มเปลี่ยนแพ็กเกจ · Member เห็น "ขอให้ Admin อัปเกรด"
 */
export function PlanLimitDialog({
  error,
  ws,
  canManage,
  onClose,
}: {
  error: ApiError | null;
  ws: string | undefined;
  canManage: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("saas-pages.limits");
  const pathname = usePathname() ?? "";
  const d = (error?.details ?? {}) as PlanLimitDetails;
  const plans = useQuery({
    queryKey: ["public-plans"],
    queryFn: () => api.get<PublicPlans>("/public/plans"),
    enabled: !!error && d.kind === "seats",
    staleTime: 300_000,
  });
  const planName = PLAN_NAMES[d.plan ?? ""] ?? d.plan ?? "";
  const suggested = d.suggestedPlan ? PLAN_NAMES[d.suggestedPlan] ?? d.suggestedPlan : null;
  const upgrade = suggested && d.suggestedPlan !== "enterprise" ? t("upgradeTo", { plan: suggested }) : t("changePlan");
  const base = ws ? `/work/${encodeURIComponent(ws)}` : "/";
  // จัดการไฟล์อยู่ในแต่ละโปรเจกต์: ถ้าเปิดจากหน้าโปรเจกต์ให้ไปหน้าไฟล์ของโปรเจกต์นั้น
  const project = pathname.match(/^\/work\/[^/]+\/p\/([^/]+)/)?.[1];

  let content: { tag: string; tone: string; title: string; description: string; bar?: { label: string; value: string; color: string }; points: string[]; manage?: { label: string; href: string } };
  if (d.kind === "seats") {
    const target = plans.data?.items.find((p) => p.code === d.suggestedPlan);
    content = {
      tag: t("seats.tag"),
      tone: styles.amber,
      title: t("seats.title", { next: (d.current ?? 0) + (d.increment ?? 1) }),
      description: `${error?.message ?? ""} · ${t("seats.guests")}`,
      bar: { label: t("seats.bar"), value: t("seats.barValue", { current: d.current ?? 0, limit: d.limit ?? 0 }), color: "var(--danger)" },
      points: [
        target?.seatLimit ? t("seats.pointPlan", { plan: target.name, seats: target.seatLimit }) : t("seats.pointUpgrade"),
        t("seats.pointDeactivate"),
      ],
      manage: { label: t("seats.manage"), href: `${base}/members` },
    };
  } else if (d.kind === "projects") {
    content = {
      tag: t("projects.tag", { plan: planName }),
      tone: styles.neutral,
      title: t("projects.title", { plan: planName, limit: d.limit ?? 0 }),
      description: t("projects.description", { current: d.current ?? 0 }),
      bar: { label: t("projects.bar"), value: `${d.current ?? 0} / ${d.limit ?? 0}`, color: "var(--warning-solid)" },
      points: [t("projects.pointTeam"), t("projects.pointArchive")],
      manage: { label: t("projects.manage"), href: base },
    };
  } else if (d.kind === "storage_bytes") {
    const size = d.increment ? (d.increment >= 1024 ** 3 ? `${bytesToGb(d.increment)} GB` : `${Math.max(1, Math.round(d.increment / MB))} MB`) : null;
    content = {
      tag: t("storage.tag"),
      tone: styles.red,
      title: t("storage.title"),
      description: size ? t("storage.description", { size }) : t("storage.descriptionPlain"),
      bar: { label: t("storage.bar"), value: t("storage.barValue", { current: bytesToGb(d.current ?? 0), limit: bytesToGb(d.limit ?? 0) }), color: "var(--danger)" },
      points: [t("storage.pointTrash"), t("storage.pointOpen")],
      manage: { label: t("storage.manage"), href: project ? `${base}/p/${project}/files` : base },
    };
  } else {
    content = { tag: t("generic.tag"), tone: styles.neutral, title: t("generic.title"), description: error?.message ?? t("generic.description"), points: [] };
  }
  const width = d.limit ? Math.min(100, Math.round(((d.current ?? 0) / d.limit) * 100)) : 100;

  return (
    <Dialog open={!!error} onOpenChange={(open) => !open && onClose()} title={content.title} description={content.description}>
      <div className={styles.body}>
        <span className={cn(styles.tag, content.tone)}>{content.tag}</span>
        {content.bar && (
          <div>
            <div className={styles.meter}>
              <span>{content.bar.label}</span>
              <b>{content.bar.value}</b>
            </div>
            <div className={styles.bar} role="presentation">
              <span style={{ width: `${width}%`, background: content.bar.color }} />
            </div>
          </div>
        )}
        {content.points.length > 0 && (
          <ul className={styles.points}>
            {content.points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className={styles.actions}>
          {canManage && ws ? (
            <>
              {content.manage && (
                <Link className={buttonVariants()} href={content.manage.href} onClick={onClose}>
                  {content.manage.label}
                </Link>
              )}
              <Link className={buttonVariants({ variant: "primary" })} href={checkoutHref(ws, d.suggestedPlan)} onClick={onClose}>
                {upgrade}
              </Link>
            </>
          ) : (
            <>
              <Button onClick={onClose}>{t("later")}</Button>
              <RequestUpgradeButton />
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/**
 * ฟัง 402 จาก API client แล้วเปิด Dialog ของ Q2 · ใช้แทน Dialog ทั่วไปใน `components/providers.tsx`
 * อยู่นอก WorkspaceShell จึงอ่าน Workspace จาก URL และถามสิทธิ์ชำระเงินจาก `GET usage`
 */
export function PlanLimitHost() {
  const pathname = usePathname() ?? "";
  const [error, setError] = useState<ApiError | null>(null);
  const ws = pathname.match(/^\/work\/([^/]+)/)?.[1];
  useEffect(() => {
    const listener = (event: Event) => setError((event as CustomEvent<ApiError>).detail);
    window.addEventListener(API_PLAN_LIMIT, listener);
    return () => window.removeEventListener(API_PLAN_LIMIT, listener);
  }, []);
  const usage = useQuery({
    queryKey: ["usage", ws],
    queryFn: () => api.get<Usage>(`/w/${ws}/usage`),
    enabled: !!error && !!ws,
    retry: false,
  });
  return <PlanLimitDialog error={error} ws={ws} canManage={!!usage.data?.canManageBilling} onClose={() => setError(null)} />;
}
