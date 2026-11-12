"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { FollowDrawer } from "./FollowDrawer";
import { canFollow, canRead } from "./access";
import { onbDetailKey, type OnboardingDetail } from "./types";
import styles from "./onboarding.module.css";

/**
 * การ์ด Onboarding ในแท็บภาพรวมของรายละเอียดลูกค้า (V7) ใต้การ์ดคะแนนสุขภาพ
 * แสดงเฉพาะ Workspace ที่ยังไม่ครบ · โหลดไม่ได้ / ไม่มีสิทธิ์ = ไม่แสดง (ไม่รบกวนหน้ารายละเอียด)
 */
export function OnboardingCard({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("onb");
  const me = useMe().data;
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: onbDetailKey(workspaceId), queryFn: () => api.get<OnboardingDetail>(`/onboarding/workspaces/${workspaceId}`), enabled: !!me && canRead(me), retry: false });
  const d = q.data;
  if (!d || d.complete) return null;
  const index = d.stuckStep ? d.steps.findIndex((s) => s.key === d.stuckStep) + 1 : 0;
  return (
    <section className="card" aria-label={t("card.title")}>
      <div className="card-head">
        <h2 className="card-title">{t("card.title")}</h2>
        <span className="spacer" />
        <span className="pill warn">
          {d.done} / {d.total}
        </span>
      </div>
      <div className={styles.cardBody}>
        <div className={styles.segments} aria-hidden="true">
          {d.steps.map((s) => (
            <span key={s.key} className={s.doneAt ? styles.segDone : s.key === d.stuckStep ? styles.segStuck : styles.segTodo} />
          ))}
        </div>
        <div className="kv">
          <span className="muted">{t("card.stuckAt")}</span>
          <span>{d.stuckStep ? t("card.stuckValue", { step: t("stepN", { index, label: t(`steps.${d.stuckStep}` as "steps.team") }), n: d.stuckDays }) : "—"}</span>
        </div>
        <div className="kv">
          <span className="muted">{t("card.assignee")}</span>
          <span>{d.followup?.assigneeName ?? "—"}</span>
        </div>
        {canFollow(me) && (
          <div>
            <Button size="small" onClick={() => setOpen(true)}>
              {t("card.follow")}
            </Button>
          </div>
        )}
      </div>
      {open && <FollowDrawer workspaceId={workspaceId} onClose={() => setOpen(false)} />}
    </section>
  );
}
