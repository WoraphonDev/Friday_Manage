"use client";
import Link from "next/link";
import { Bell as BellIcon } from "lucide-react";
import { useTranslations } from "next-intl";

export function Bell({
  workspace,
  unread = 0,
}: {
  workspace: string;
  unread?: number;
}) {
  const t = useTranslations("common.nav");
  return (
    <Link
      className="button button-ghost button-icon notification-button"
      href={`/w/${encodeURIComponent(workspace)}/inbox`}
      aria-label={t("notifications", { count: unread })}
    >
      <BellIcon size={20} />
      {unread > 0 && (
        <span className="notification-count" aria-hidden="true">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
