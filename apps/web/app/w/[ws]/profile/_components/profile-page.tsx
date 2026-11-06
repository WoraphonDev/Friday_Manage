"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Tabs } from "@/components/ui";
import { cn } from "@/lib/utils";
import { HoursTab } from "./hours-tab";
import { NotifyTab } from "./notify-tab";
import { PersonalTab } from "./personal-tab";
import { SecurityTab } from "./security-tab";
import { SummaryCard } from "./summary-card";
import styles from "./profile.module.css";

export const PROFILE_TABS = ["profile", "notify", "hours", "sec"] as const;
export type ProfileTab = (typeof PROFILE_TABS)[number];

/** หน้า I · Profile ของฉัน: การ์ดสรุป + 4 แท็บ (แท็บอยู่ใน ?tab= เพื่อให้ลิงก์จาก Inbox / OAuth กลับมาที่แท็บเดิมได้) */
export function ProfilePage({ ws }: { ws: string }) {
  const t = useTranslations("profile");
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const fromUrl = params.get("tab");
  // Canvas I เปิดที่แท็บการแจ้งเตือน
  const [tab, setTab] = useState<ProfileTab>(PROFILE_TABS.includes(fromUrl as ProfileTab) ? (fromUrl as ProfileTab) : "notify");
  const pick = (value: string) => {
    setTab(value as ProfileTab);
    const next = new URLSearchParams(params.toString());
    next.set("tab", value);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
  const content: Record<ProfileTab, React.ReactNode> = {
    profile: <PersonalTab ws={ws} />,
    notify: <NotifyTab ws={ws} />,
    hours: <HoursTab ws={ws} />,
    sec: <SecurityTab ws={ws} />,
  };
  return (
    <div className={styles.page}>
      <SummaryCard ws={ws} />
      <section className={cn("card", styles.main)} aria-label={t("title")}>
        <Tabs label={t("tabsLabel")} value={tab} onValueChange={pick} items={PROFILE_TABS.map((value) => ({ value, label: t(`tabs.${value}`), content: content[value] }))} />
      </section>
    </div>
  );
}
