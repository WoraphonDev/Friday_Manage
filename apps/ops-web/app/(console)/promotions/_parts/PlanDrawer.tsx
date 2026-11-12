"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useApprovalFlow, useReauth } from "@/components/dialogs";
import { Drawer } from "@/components/kit";
import { Button, InlineError, Input, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useFmt } from "../../workspaces/_parts/format";
import { bahtToSatang, type PlanRow, satangToBaht } from "./types";

type Policy = "grandfather" | "next_cycle";

/**
 * P1 · แก้ไขแพ็กเกจ · ทุกการบันทึกเป็นเวอร์ชันใหม่ · ต้องแตะ Security key (G4)
 * เปลี่ยนราคา = ต้องมีคนอนุมัติเสมอ (202) · แก้ชื่อ / การแสดงผลอย่างเดียว = มีผลทันที
 */
export function PlanDrawer({ plan, onClose }: { plan: PlanRow; onClose: () => void }) {
  const t = useTranslations("promo.plan");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const { handle } = useApprovalFlow();
  const [name, setName] = useState(plan.name);
  const [monthly, setMonthly] = useState(satangToBaht(plan.monthlySatang));
  // ราคาปีที่ไม่ได้ตั้งเอง (เดือน × 10) แสดงเป็นช่องว่าง ให้คิดตามราคาเดือนใหม่อัตโนมัติ
  const [yearly, setYearly] = useState(plan.yearlyCustom ? satangToBaht(plan.yearlySatang) : "");
  const [listed, setListed] = useState(plan.listed);
  const [open, setOpen] = useState(plan.openForSignup);
  const [policy, setPolicy] = useState<Policy>("grandfather");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);

  const monthlySatang = plan.priceEditable ? bahtToSatang(monthly) : plan.monthlySatang;
  const yearlySatang = plan.priceEditable ? bahtToSatang(yearly) : plan.yearlyCustom ? plan.yearlySatang : null;
  const priceInvalid = plan.priceEditable && (monthlySatang === null || Number.isNaN(monthlySatang) || Number.isNaN(yearlySatang));
  const priceChanged = monthlySatang !== plan.monthlySatang || yearlySatang !== (plan.yearlyCustom ? plan.yearlySatang : null);
  const nameOk = name.trim().length >= 1 && name.trim().length <= 40;
  const reasonOk = reason.trim().length >= 3;
  const ok = nameOk && reasonOk && !priceInvalid;

  const m = useMutation({
    mutationFn: () =>
      run(
        () =>
          api.post<{ version?: number; pendingApproval?: unknown }>(`/promotions/plans/${plan.code}`, {
            displayName: name.trim(),
            monthlySatang,
            yearlySatang,
            listed,
            openForSignup: open,
            existingPolicy: priceChanged ? policy : "grandfather",
            reason: reason.trim(),
          }),
        t("title", { plan: plan.name }),
      ).then(handle),
    onSuccess: (r) => {
      if (!r.pendingApproval) toast(t("done", { plan: name.trim(), version: r.version ?? "" }));
      void cache.invalidateQueries({ queryKey: ["ops"] });
      onClose();
    },
  });

  const autoYearly = monthlySatang != null && !Number.isNaN(monthlySatang) ? fmt.money(monthlySatang * plan.yearlyMonths) : "—";
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={t("title", { plan: plan.name })} description={t("desc", { count: plan.customers })} wide>
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (ok) m.mutate();
        }}
      >
        <div className="grid-2">
          <Input label={`${t("name")} *`} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} error={touched && !nameOk ? t("name") : undefined} />
          <Input label={t("code")} value={plan.code} readOnly disabled className="mono" hint={t("codeHint")} />
          <Input
            label={`${t("monthly")} *`}
            inputMode="decimal"
            value={plan.priceEditable ? monthly : plan.monthlySatang === null ? "—" : satangToBaht(plan.monthlySatang)}
            disabled={!plan.priceEditable}
            onChange={(e) => setMonthly(e.target.value)}
            hint={t("monthlyHint")}
            error={touched && priceInvalid ? t("invalidPrice") : undefined}
          />
          <Input
            label={t("yearly")}
            inputMode="decimal"
            value={plan.priceEditable ? yearly : plan.yearlySatang === null ? "—" : satangToBaht(plan.yearlySatang)}
            disabled={!plan.priceEditable}
            placeholder={plan.priceEditable ? autoYearly : undefined}
            onChange={(e) => setYearly(e.target.value)}
            hint={yearly.trim() ? t("yearlyHintSet", { months: 12 - plan.yearlyMonths }) : t("yearlyHint", { months: plan.yearlyMonths, price: autoYearly })}
          />
        </div>
        {!plan.priceEditable && <p className="muted small">{t("notEditable")}</p>}
        <dl className="promo-kv">
          <dt>{t("seats")}</dt>
          <dd>{plan.seatLimit === null ? t("seatsUnlimited") : t("seatsValue", { count: plan.seatLimit })}</dd>
          <dt>{t("otherLimits")}</dt>
          <dd>
            <Link href="/entitlements">{t("otherLink")}</Link>
          </dd>
        </dl>
        <div className="promo-checks">
          <label className="check">
            <input type="checkbox" checked={listed} onChange={(e) => setListed(e.target.checked)} />
            <span>{t("listed")}</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} />
            <span>{t("openForSignup")}</span>
          </label>
        </div>
        <fieldset className="promo-fieldset" disabled={!priceChanged}>
          <legend className="field-label">{t("whenPrice")}</legend>
          <div className="promo-options">
            {(["grandfather", "next_cycle"] as const).map((p) => (
              <label key={p} className={clsx("opt", priceChanged && policy === p && "opt-on")}>
                <input type="radio" name="policy" value={p} checked={policy === p} onChange={() => setPolicy(p)} />
                <span>
                  <b>{p === "grandfather" ? t("grandfather") : t("nextCycle")}</b>
                  <span className="muted small">{p === "grandfather" ? t("grandfatherDesc") : t("nextCycleDesc")}</span>
                </span>
              </label>
            ))}
          </div>
          {!priceChanged && <p className="muted small">{t("noPriceChange")}</p>}
        </fieldset>
        <Textarea label={`${t("reason")} *`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} error={touched && !reasonOk ? tc("reasonRequired", { min: 3 }) : undefined} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <span className="muted small push-start">{t("note")}</span>
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={m.isPending}>
            {m.isPending ? tc("saving") : t("save")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
