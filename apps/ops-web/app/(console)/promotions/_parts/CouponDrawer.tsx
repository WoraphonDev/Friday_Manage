"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useApprovalFlow, useReauth } from "@/components/dialogs";
import { Drawer, Seg } from "@/components/kit";
import { Button, InlineError, Input, Select, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { COUPON_PLANS, type Coupon, type CouponDuration, type CouponKind, PLAN_NAME, PROMO_KEY, satangToBaht, useCouponText } from "./types";

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/;

interface Form {
  code: string;
  description: string;
  kind: CouponKind;
  value: string;
  duration: CouponDuration;
  cycles: string;
  planCodes: string[];
  max: string;
  expiresOn: string;
  newOnly: boolean;
  stackable: boolean;
}
type Errors = Partial<Record<keyof Form, string>>;

const EMPTY: Form = { code: "", description: "", kind: "percent", value: "", duration: "repeating", cycles: "3", planCodes: ["team_s", "team_m", "team_l"], max: "", expiresOn: "", newOnly: false, stackable: false };

/** คูปองเดิม → ค่าในฟอร์ม (แก้ร่าง / คัดลอกเป็นคูปองใหม่) */
export function formOf(c: Coupon, copy: boolean): Form {
  return {
    code: copy ? "" : c.code,
    description: c.description ?? "",
    kind: c.kind,
    value: c.kind === "amount" ? satangToBaht(c.value) : String(c.value),
    duration: c.duration,
    cycles: String(c.durationCycles ?? 3),
    planCodes: [...c.planCodes],
    max: c.maxRedemptions == null ? "" : String(c.maxRedemptions),
    expiresOn: c.expiresOn ?? "",
    newOnly: c.newCustomersOnly,
    stackable: c.stackable,
  };
}

/** ช่องในฟอร์มที่ตรงกับ path ของ ops-api (zod) */
const FIELD: Record<string, keyof Form> = { code: "code", description: "description", kind: "kind", value: "value", duration: "duration", durationCycles: "cycles", planCodes: "planCodes", maxRedemptions: "max", expiresOn: "expiresOn" };

/**
 * สร้าง / แก้ร่างคูปอง (Canvas › Promotions drawer) · "บันทึกร่าง" ไม่ต้องแตะกุญแจ
 * "เปิดใช้คูปอง" ต้องแตะ Security key (G4) · ส่วนลดเกินวงเงินของพนักงานขึ้นคำขออนุมัติ (202)
 */
export function CouponDrawer({ initial, editing, onClose }: { initial?: Form; editing?: Coupon; onClose: () => void }) {
  const t = useTranslations("promo.form");
  const tp = useTranslations("promo");
  const tc = useTranslations("common.dialog");
  const text = useCouponText();
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const { handle } = useApprovalFlow();
  const [f, setF] = useState<Form>(initial ?? EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };
  const free = f.kind === "free_months";
  const duration: CouponDuration = free ? "once" : f.duration;

  const rawValue = f.value.replace(/[,\s฿%]/g, "");
  const num = Number(rawValue);
  const value = !rawValue || !Number.isFinite(num) ? null : f.kind === "amount" ? Math.round(num * 100) : Math.trunc(num);
  const cycles = Number(f.cycles);

  function validate(): Errors {
    const e: Errors = {};
    if (!CODE_RE.test(f.code.trim())) e.code = t("codeInvalid");
    const valueOk = value !== null && (f.kind === "percent" ? value >= 1 && value <= 100 : f.kind === "amount" ? value >= 100 : value >= 1 && value <= 24);
    if (!valueOk) e.value = t("valueInvalid");
    if (duration === "repeating" && !(Number.isInteger(cycles) && cycles >= 1 && cycles <= 36)) e.cycles = t("valueInvalid");
    if (!f.planCodes.length) e.planCodes = t("plansRequired");
    if (f.max.trim() && !(Number.isInteger(Number(f.max)) && Number(f.max) > 0)) e.max = t("valueInvalid");
    return e;
  }
  const body = () => ({
    code: f.code.trim().toUpperCase(),
    description: f.description.trim() || null,
    kind: f.kind,
    value,
    duration,
    durationCycles: duration === "repeating" ? cycles : null,
    planCodes: COUPON_PLANS.filter((p) => f.planCodes.includes(p)),
    maxRedemptions: f.max.trim() ? Number(f.max) : null,
    expiresOn: f.expiresOn || null,
    newCustomersOnly: f.newOnly,
    stackable: free ? false : f.stackable,
  });
  /** ข้อผิดพลาดของ ops-api ที่ชี้ช่อง (400 validation_failed · 409 โค้ดซ้ำ) แสดงใต้ช่องนั้น */
  const fieldErrors = (e: unknown) => {
    if (!(e instanceof ApiError)) return;
    if (e.code === "coupon_code_taken") return setErrors((x) => ({ ...x, code: t("codeTaken") }));
    const issues = (e.details.issues ?? e.details.fields) as { path: string; message: string }[] | undefined;
    if (Array.isArray(issues)) setErrors((x) => ({ ...x, ...Object.fromEntries(issues.filter((i) => FIELD[i.path]).map((i) => [FIELD[i.path], i.message])) }));
  };

  const m = useMutation({
    mutationFn: async (activate: boolean): Promise<{ coupon?: Coupon; pendingApproval?: unknown; activate: boolean }> => {
      const b = body();
      if (!editing) {
        const r = activate
          ? await run(() => api.post<{ coupon: Coupon; pendingApproval?: unknown }>("/promotions/coupons", { ...b, activate: true }), t("activate"))
          : await api.post<{ coupon: Coupon }>("/promotions/coupons", b);
        return { ...handle(r), activate };
      }
      // แก้ร่าง: บันทึกก่อน แล้วค่อยขอเปิดใช้ (ร่างที่บันทึกแล้วไม่หายถ้าแตะกุญแจไม่สำเร็จ)
      const saved = await api.patch<{ coupon: Coupon }>(`/promotions/coupons/${editing.id}`, b);
      if (!activate) return { ...saved, activate };
      const r = await run(() => api.post<{ coupon?: Coupon; pendingApproval?: unknown }>(`/promotions/coupons/${editing.id}/activate`, {}), t("activate"));
      return { coupon: r.coupon ?? saved.coupon, ...handle(r), activate };
    },
    onSuccess: (r) => {
      const code = r.coupon?.code ?? body().code;
      if (!r.pendingApproval) toast(r.activate ? tp("activated", { code }) : t("savedDraft", { code }));
      void cache.invalidateQueries({ queryKey: PROMO_KEY });
      onClose();
    },
    onError: fieldErrors,
  });
  const submit = (activate: boolean) => {
    const e = validate();
    setErrors(e);
    if (!Object.keys(e).length) m.mutate(activate);
  };
  const shown = m.error instanceof ApiError && (m.error.code === "coupon_code_taken" || m.error.code === "validation_failed") ? null : m.error;
  const valueLabel = f.kind === "percent" ? t("valuePercent") : f.kind === "amount" ? t("valueAmount") : t("valueMonths");
  const previewCoupon = { kind: f.kind, value: value ?? 0, duration, durationCycles: Number.isFinite(cycles) ? cycles : 1, expiresOn: f.expiresOn || null };

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={editing ? t("editTitle", { code: editing.code }) : t("createTitle")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), submit(false))} noValidate>
        <Input label={t("code")} className="mono" value={f.code} maxLength={32} autoCapitalize="characters" onChange={(e) => set("code", e.target.value.toUpperCase())} hint={t("codeHint")} error={errors.code} />
        <Input label={t("description")} value={f.description} maxLength={200} onChange={(e) => set("description", e.target.value)} error={errors.description} />
        <div className="field">
          <span className="field-label">{t("kind")}</span>
          <Seg
            label={t("kind")}
            value={f.kind}
            onChange={(k) => set("kind", k)}
            options={(["percent", "amount", "free_months"] as const).map((k) => ({ value: k, label: t(`kinds.${k}`) }))}
          />
        </div>
        <div className="grid-2">
          <Input label={valueLabel} inputMode="decimal" value={f.value} onChange={(e) => set("value", e.target.value)} error={errors.value} />
          {free ? (
            <Input label={t("duration")} value={t("durations.once")} disabled hint={t("freeOnce")} />
          ) : (
            <Select label={t("duration")} value={f.duration} onChange={(e) => set("duration", e.target.value as CouponDuration)}>
              {(["repeating", "once", "forever"] as const).map((d) => (
                <option key={d} value={d}>
                  {t(`durations.${d}`)}
                </option>
              ))}
            </Select>
          )}
          {duration === "repeating" && <Input label={t("cycles")} inputMode="numeric" value={f.cycles} onChange={(e) => set("cycles", e.target.value.replace(/\D/g, ""))} error={errors.cycles} />}
        </div>
        <fieldset className="promo-fieldset">
          <legend className="field-label">{t("plans")}</legend>
          <div className="row">
            {COUPON_PLANS.map((p) => (
              <label key={p} className="check">
                <input type="checkbox" checked={f.planCodes.includes(p)} onChange={(e) => set("planCodes", e.target.checked ? [...f.planCodes, p] : f.planCodes.filter((x) => x !== p))} />
                <span>{PLAN_NAME[p]}</span>
              </label>
            ))}
          </div>
          {errors.planCodes && (
            <span className="field-error" role="alert">
              {errors.planCodes}
            </span>
          )}
        </fieldset>
        <div className="grid-2">
          <Input label={t("max")} inputMode="numeric" value={f.max} placeholder={tp("coupons.unlimited")} onChange={(e) => set("max", e.target.value.replace(/\D/g, ""))} hint={t("maxHint")} error={errors.max} />
          <Input label={t("expires")} type="date" value={f.expiresOn} onChange={(e) => set("expiresOn", e.target.value)} hint={t("expiresHint")} error={errors.expiresOn} />
        </div>
        <label className="check">
          <input type="checkbox" checked={f.newOnly} onChange={(e) => set("newOnly", e.target.checked)} />
          <span>{t("newOnly")}</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={!free && f.stackable} disabled={free} onChange={(e) => set("stackable", e.target.checked)} />
          <span>{t("stackable")}</span>
        </label>
        <div className="promo-preview" aria-live="polite">
          <div className="muted small">{tp("preview.label")}</div>
          <b>{value ? text.preview(previewCoupon) : "—"}</b>
        </div>
        <p className="muted small">{t("limitNote")}</p>
        <InlineError error={shown} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" disabled={m.isPending}>
            {editing ? t("save") : t("saveDraft")}
          </Button>
          <Button variant="primary" disabled={m.isPending} onClick={() => submit(true)}>
            {editing ? t("saveActivate") : t("activate")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
