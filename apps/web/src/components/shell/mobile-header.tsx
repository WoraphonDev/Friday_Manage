"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Bell, Search } from "lucide-react";
import { FridayMark } from "@/components/brand/friday-logo";
import { useWorkspace } from "./workspace-shell";

/**
 * หัวหน้ามือถือแบบ B ของต้นแบบ (W29 · docs/prototypes/mobile): แถวบน = ไทล์โลโก้ (เปิดเมนู Workspace) + ปุ่มของหน้า + ค้นหา + กระดิ่ง
 * แล้วหัวข้อใหญ่และคำอธิบาย · ใช้เฉพาะใน component ที่ render เมื่อ useIsMobile() เป็นจริง
 * กระดิ่งพาไปกล่องข้อความ (Bell ของ desktop ยัง mount อยู่ในแถบบนที่ซ่อนไว้และถือ realtime socket ตัวเดียว)
 */
export function MobileHeader({
  title,
  subtitle,
  actions,
  search = true,
  bell = true,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** ปุ่มเฉพาะหน้า (เช่น ตัวกรอง, ⋯) วางก่อนค้นหา · ใช้ className="m-icon" */
  actions?: ReactNode;
  search?: boolean;
  bell?: boolean;
}) {
  const t = useTranslations("common");
  const { workspace, openMenu, openSearch, unread = 0 } = useWorkspace();
  return (
    <header className="m-head">
      <div className="m-head-row">
        <button type="button" className="m-icon m-logo" aria-label={t("mobile.workspaceMenu", { name: workspace.name })} onClick={() => openMenu?.()}>
          <FridayMark />
        </button>
        <span className="m-spacer" />
        {actions}
        {search && (
          <button type="button" className="m-icon" aria-label={t("nav.search")} onClick={() => openSearch?.()}>
            <Search size={20} aria-hidden="true" />
          </button>
        )}
        {bell && (
          <Link
            className="m-icon"
            href={`/work/${encodeURIComponent(workspace.slug)}/inbox`}
            aria-label={unread ? t("nav.notifications", { count: unread }) : t("mobile.notifications")}
          >
            <Bell size={20} aria-hidden="true" />
            {unread > 0 && <span className="m-icon-badge" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
          </Link>
        )}
      </div>
      <h1 className="m-title">{title}</h1>
      {subtitle && <div className="m-subtitle">{subtitle}</div>}
    </header>
  );
}
