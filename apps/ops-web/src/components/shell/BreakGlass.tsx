"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { api } from "@/lib/api";
import { OPS_ROLES, type OpsRole, type Staff } from "@/lib/types";
import { rolesOf } from "../access";
import { useReauth } from "../dialogs";
import { Modal, Notice, Seg } from "../kit";
import { Button, InlineError, Textarea, useToast } from "../ui";

/** A12 · Owner เปิดบทบาทที่ไม่มีให้ตัวเอง 30 นาทีหรือ 1 ชม. · ต้องใส่เหตุผลและแตะกุญแจ (ops-api › staff/me/elevations) */
export function BreakGlassDialog({ staff, open, onOpenChange, initialRole }: { staff: Staff; open: boolean; onOpenChange: (o: boolean) => void; initialRole?: OpsRole }) {
  const t = useTranslations("staff.glass");
  const tc = useTranslations("common");
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const missing = OPS_ROLES.filter((r) => !(staff.roles ?? rolesOf(staff)).includes(r) && r !== "owner");
  const [role, setRole] = useState<OpsRole | undefined>(initialRole && missing.includes(initialRole) ? initialRole : missing[0]);
  const [minutes, setMinutes] = useState<"30" | "60">("60");
  const [reason, setReason] = useState("");
  const open_ = useMutation({
    mutationFn: () => run(() => api.post("/staff/me/elevations", { role, minutes: Number(minutes), reason: reason.trim() }), t("submit")),
    onSuccess: () => {
      toast(t("done"));
      setReason("");
      onOpenChange(false);
      void cache.invalidateQueries({ queryKey: ["ops"] });
    },
  });
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t("modalTitle", { role: role ? tc(`roles.${role}`) : "" })} description={t("modalDesc")}>
      {!missing.length ? (
        <p className="muted">{t("allHave")}</p>
      ) : (
        <form
          className="dialog-body"
          onSubmit={(e) => {
            e.preventDefault();
            if (role && reason.trim().length >= 10) open_.mutate();
          }}
        >
          <div className="field">
            <span className="field-label">{t("role")}</span>
            <Seg label={t("role")} value={role ?? missing[0]} onChange={(v) => setRole(v)} options={missing.map((r) => ({ value: r, label: tc(`roles.${r}`) }))} />
          </div>
          <div className="field">
            <span className="field-label">{t("duration")}</span>
            <Seg label={t("duration")} value={minutes} onChange={setMinutes} options={[{ value: "30", label: t("m30") }, { value: "60", label: t("m60") }]} />
          </div>
          <Textarea label={tc("dialog.reason")} value={reason} onChange={(e) => setReason(e.target.value)} hint={t("reasonHint")} />
          <Notice tone="bad" icon={<ShieldAlert size={18} />} title={t("note")}>
            {t("ownerOnly")}
          </Notice>
          <InlineError error={open_.error} />
          <div className="dialog-actions">
            <Button onClick={() => onOpenChange(false)}>{tc("dialog.cancel")}</Button>
            <Button type="submit" variant="danger" disabled={!role || reason.trim().length < 10 || open_.isPending}>
              {t("submit")}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
