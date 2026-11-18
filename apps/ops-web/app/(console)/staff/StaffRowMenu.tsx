"use client";

import { useMutation } from "@tanstack/react-query";
import { KeyRound, MoreHorizontal, ScrollText, Settings } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { CopyButton, Notice, Popover } from "@/components/kit";
import { Button, Dialog, InlineError, Input, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import type { StaffMember } from "./types";

/** อายุโทเค็นลิงก์ตั้งค่า (signEnrollToken ใน ops-api = 3600 วินาที) */
const LINK_MINUTES = 60;

/**
 * เมนู ⋯ ท้ายแถวพนักงาน (Owner) · ทางลัดออกลิงก์ตั้งค่าการเข้าระบบใหม่เมื่อลืมรหัสผ่าน/มือถือหาย
 * โดยไม่ต้องเปิดแผงจัดการแล้วเลื่อนลงไปท้ายสุด · แถวของตัวเองไม่มีรายการนี้เพราะยังเข้าระบบอยู่
 */
export function StaffRowMenu({ member, mine, onManage }: { member: StaffMember; mine: boolean; onManage: () => void }) {
  const t = useTranslations("staff.rowMenu");
  const [reset, setReset] = useState(false);
  const disabled = member.status === "disabled";
  return (
    <>
      <Popover
        label={t("label", { name: member.name })}
        trigger={({ toggle, open }) => (
          <Button variant="ghost" size="icon" aria-label={t("label", { name: member.name })} aria-expanded={open} onClick={toggle}>
            <MoreHorizontal size={16} />
          </Button>
        )}
      >
        {(close) => (
          <>
            {!mine && (
              <button type="button" className="menu-item" disabled={disabled} onClick={() => (close(), setReset(true))}>
                <KeyRound size={16} aria-hidden="true" />
                <span className="menu-item-text">
                  <span className="cell-main">{member.status === "invited" ? t("resendInvite") : t("reset")}</span>
                  <span className="cell-sub">{disabled ? t("disabledHint") : t("resetHint")}</span>
                </span>
              </button>
            )}
            <Link className="menu-item" href={`/staff?tab=audit&staff=${member.id}`} onClick={close}>
              <ScrollText size={16} aria-hidden="true" /> {t("audit")}
            </Link>
            <div className="menu-sep" />
            <button type="button" className="menu-item" onClick={() => (close(), onManage())}>
              <Settings size={16} aria-hidden="true" /> {t("manage")}
            </button>
          </>
        )}
      </Popover>
      {reset && <ResetLinkDialog member={member} onClose={() => setReset(false)} />}
    </>
  );
}

/** ยืนยันก่อน (กด ⋯ ผิดแถวได้ง่าย) แล้วกล่องเดียวกันเปลี่ยนเป็นลิงก์ให้คัดลอก · ไม่ส่งอีเมลเอง ให้ Owner ส่งทางช่องทางที่ยืนยันตัวตนได้ */
function ResetLinkDialog({ member, onClose }: { member: StaffMember; onClose: () => void }) {
  const t = useTranslations("staff.rowMenu");
  const ts = useTranslations("staff.manageForm");
  const format = useFormatter();
  const toast = useToast();
  const [result, setResult] = useState<{ url: string; until: Date } | null>(null);
  const issue = useMutation({
    mutationFn: () => api.post<{ enrollUrl: string }>(`/staff/${member.id}/enroll-link`),
    onSuccess: (r) => {
      setResult({ url: r.enrollUrl, until: new Date(Date.now() + LINK_MINUTES * 60_000) });
      toast(ts("enrollLinkDone"));
    },
  });
  // Dialog เล่น animation ปิดเองตอนถูกถอดออก (useExitGhost)
  const close = (o: boolean) => !o && onClose();
  const invited = member.status === "invited";
  return (
    <Dialog open onOpenChange={close} title={result ? t("linkTitle", { name: member.name }) : t(invited ? "confirmInviteTitle" : "confirmTitle", { name: member.name })}>
      {result ? (
        <div className="stack">
          <Input label={t("linkLabel", { time: format.dateTime(result.until, { timeStyle: "short" }) })} value={result.url} readOnly className="mono" onFocus={(e) => e.currentTarget.select()} />
          <CopyButton text={result.url} />
          <Notice tone="warn">{t("sendSafely", { name: member.name })}</Notice>
          <div className="dialog-actions">
            <Button onClick={() => close(false)}>{t("close")}</Button>
          </div>
        </div>
      ) : (
        <div className="stack">
          <ul className="muted small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>{t("pointLink", { minutes: LINK_MINUTES })}</li>
            {!invited && <li>{t("pointOldPassword", { name: member.name })}</li>}
            {!invited && <li>{t("pointPasskey")}</li>}
            <li>{t("pointAudit")}</li>
          </ul>
          <InlineError error={issue.error} />
          <div className="dialog-actions">
            <Button onClick={() => close(false)}>{t("cancel")}</Button>
            <Button variant="primary" disabled={issue.isPending} onClick={() => issue.mutate()}>
              {t("issue")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
