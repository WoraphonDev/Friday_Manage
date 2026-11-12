"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ConfirmDialog } from "@/components/dialogs";
import { Notice } from "@/components/kit";
import { useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useFmt } from "../../workspaces/_parts/format";
import { CHANGELOG_KEY, type Entry } from "./types";

/** U7 · ซ่อน / ยกเลิกการเผยแพร่ (G5 แบบมาตรฐาน: ต้องมีเหตุผล) */
export function HideDialog({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const t = useTranslations("cl.hide");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const desc =
    entry.status === "scheduled"
      ? t("scheduled", { at: fmt.dateTime(entry.publishedAt) })
      : entry.status === "published"
        ? t("published", { at: fmt.date(entry.publishedAt), views: fmt.num(entry.views) })
        : t("draft");
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("title", { title: entry.title })}
      description={desc}
      confirmLabel={t("confirm")}
      reasonLabel={t("reason")}
      danger
      onConfirm={async ({ reason }) => {
        await api.post(`/changelog/${entry.id}/hide`, { reason });
        toast(t("done", { title: entry.title }));
        await cache.invalidateQueries({ queryKey: CHANGELOG_KEY });
      }}
    >
      <Notice tone="warn">{t("warn")}</Notice>
    </ConfirmDialog>
  );
}
