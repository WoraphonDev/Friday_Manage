"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Chip, Drawer, Notice } from "@/components/kit";
import { Button, InlineError, Select, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { PLAN_LABEL } from "../../../workspaces/_parts/format";
import { CATEGORIES, type Category, PLANS, type Plan, PRIORITIES, type Priority, SETTINGS_KEY, TARGETS, type Target } from "./types";

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** T6 · เพิ่มกฎการแจกงาน: เมื่อ (แพ็กเกจ และ ประเภท) → แจกให้กลุ่ม + ความสำคัญเริ่มต้น · นับ Ticket ที่เปิดอยู่ที่ตรง */
export function RuleDrawer({ onClose }: { onClose: () => void }) {
  const t = useTranslations("sset");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [target, setTarget] = useState<Target>("l1");
  const [priority, setPriority] = useState<Priority>("normal");
  const body = { plans, categories, target, priority };
  const preview = useQuery({ queryKey: ["ops", "support", "rule-preview", plans, categories], queryFn: () => api.post<{ matches: number }>("/support/rules/preview", body), staleTime: 0 });
  const m = useMutation({
    mutationFn: () => api.post("/support/rules", body),
    onSuccess: () => (toast(t("t6.done")), void cache.invalidateQueries({ queryKey: SETTINGS_KEY }), onClose()),
  });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={t("t6.title")} description={t("t6.desc")}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
        <h3 className="field-label">{t("t6.when")}</h3>
        <fieldset className="chip-field">
          <legend className="small">
            {t("t6.plans")} <span className="muted">· {t("t6.plansHint")}</span>
          </legend>
          <div className="row">
            {PLANS.map((p) => (
              <Chip key={p} pressed={plans.includes(p)} onClick={() => setPlans(toggle(plans, p))}>
                {PLAN_LABEL[p]}
              </Chip>
            ))}
          </div>
        </fieldset>
        <fieldset className="chip-field">
          <legend className="small">
            {t("t6.categories")} <span className="muted">· {t("t6.categoriesHint")}</span>
          </legend>
          <div className="row">
            {CATEGORIES.map((c) => (
              <Chip key={c} pressed={categories.includes(c)} onClick={() => setCategories(toggle(categories, c))}>
                {t(`category.${c}`)}
              </Chip>
            ))}
          </div>
        </fieldset>
        <h3 className="field-label">{t("t6.then")}</h3>
        <div className="grid-2">
          <Select label={t("t6.target")} value={target} onChange={(e) => setTarget(e.target.value as Target)} hint={target === "acct" ? t("t6.fallback") : undefined}>
            {TARGETS.map((x) => (
              <option key={x} value={x}>
                {t(`target.${x}`)}
              </option>
            ))}
          </Select>
          <Select label={t("t6.priority")} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {PRIORITIES.map((x) => (
              <option key={x} value={x}>
                {t(`priority.${x}`)}
              </option>
            ))}
          </Select>
        </div>
        {preview.data && <Notice tone="info" title={t("t6.matches", { n: preview.data.matches })}>{t("t6.position")}</Notice>}
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={m.isPending}>
            {t("t6.submit")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
