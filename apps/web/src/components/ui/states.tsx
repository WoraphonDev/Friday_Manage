"use client";

import {
  FileQuestion,
  FolderOpen,
  LockKeyhole,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { ApiError, supportId } from "@/lib/api";
import { Button, Skeleton } from "./primitives";

function State({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <section className="state">
      <span className="state-icon" aria-hidden="true">
        {icon}
      </span>
      <h2>{title}</h2>
      {description && <p className="muted">{description}</p>}
      {children}
    </section>
  );
}
export function EmptyState({
  title,
  description,
  action,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
}) {
  const t = useTranslations("common.states");
  return (
    <State
      icon={<FolderOpen />}
      title={title ?? t("emptyTitle")}
      description={description ?? t("emptyDescription")}
    >
      {action}
    </State>
  );
}
export function ErrorState({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  const t = useTranslations("common");
  const apiError = error instanceof ApiError ? error : null;
  return (
    <div role="alert">
      <State
        icon={<TriangleAlert />}
        title={t("states.errorTitle")}
        description={
          error instanceof Error ? error.message : t("app.unknownError")
        }
      >
        {supportId(apiError) && (
          <code className="request-id">
            {t("app.requestId", { id: supportId(apiError) ?? "" })}
          </code>
        )}
        {retry && (
          <Button onClick={retry}>
            <RefreshCw size={16} />
            {t("app.retry")}
          </Button>
        )}
      </State>
    </div>
  );
}
export function Forbidden({
  requestAccess,
  joinAsAdmin,
}: {
  requestAccess?: () => void;
  joinAsAdmin?: () => void;
}) {
  const t = useTranslations("common.states");
  return (
    <State
      icon={<LockKeyhole />}
      title={t("forbiddenTitle")}
      description={t("forbiddenDescription")}
    >
      {joinAsAdmin ? (
        <Button variant="primary" onClick={joinAsAdmin}>
          {t("joinAsAdmin")}
        </Button>
      ) : requestAccess ? (
        <Button onClick={requestAccess}>{t("requestAccess")}</Button>
      ) : null}
    </State>
  );
}
export function NotFound() {
  const t = useTranslations("common.states");
  return (
    <State
      icon={<FileQuestion />}
      title={t("notFoundTitle")}
      description={t("notFoundDescription")}
    />
  );
}
export function LoadingState() {
  const t = useTranslations("common.app");
  return (
    <div className="loading-state" aria-label={t("loading")} aria-busy="true">
      <Skeleton className="skeleton-heading" />
      <Skeleton />
      <Skeleton />
      <Skeleton />
    </div>
  );
}
export function ConflictState({ onLoadLatest }: { onLoadLatest: () => void }) {
  const t = useTranslations("common.states");
  return (
    <div className="notice" role="alert">
      <span>{t("conflict")}</span>
      <Button size="small" onClick={onLoadLatest}>
        {t("loadLatest")}
      </Button>
    </div>
  );
}
