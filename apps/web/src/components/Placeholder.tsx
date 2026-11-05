"use client";

import { useTranslations } from "next-intl";
import { EmptyState } from "./ui";

export function Placeholder({
  task,
  titleKey = "states.placeholderTitle",
}: {
  task: string;
  titleKey?: string;
}) {
  const t = useTranslations("common");
  return (
    <div className="page-content" data-task={task}>
      <h1 className="page-title">{t(titleKey)}</h1>
      <div className="card">
        <EmptyState
          title={t("states.placeholderTitle")}
          description={t("states.placeholderDescription")}
        />
      </div>
    </div>
  );
}
