"use client";
import { useTranslations } from "next-intl";
import { Drawer, EmptyState } from "@/components/ui";

export function IssueDrawer({
  issueKey,
  onClose,
}: {
  issueKey?: string;
  onClose: () => void;
}) {
  const t = useTranslations("common");
  return (
    <Drawer
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        issueKey
          ? t("features.issueTitle", { key: issueKey })
          : t("features.newIssue")
      }
    >
      <EmptyState
        title={t("features.issuePending")}
        description={t("states.placeholderDescription")}
      />
    </Drawer>
  );
}
