"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { ErrorBlock, Modal, Notice, Switch } from "@/components/kit";
import { Button, InlineError, Input, LoadingState, Select, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import styles from "../changelog.module.css";
import { NPS_KEY, type NpsSettings } from "./types";

type Payload = { settings: NpsSettings; eligible: { admins: number; members: number }; canEdit: boolean };
const FIRST = [0, 14, 30, 60, 90];
const REPEAT = [30, 60, 90, 180, 365];
const SAMPLE = [10, 25, 50, 75, 100];

/** U5 · ตั้งค่าแบบสำรวจ NPS (Owner เท่านั้น · ถามในแอปเท่านั้น ไม่ส่งอีเมล) */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations("cl.settingsDialog");
  const toast = useToast();
  const cache = useQueryClient();
  const q = useQuery({ queryKey: [...NPS_KEY, "settings"], queryFn: () => api.get<Payload>("/nps/settings") });
  const [v, setV] = useState<NpsSettings | null>(null);
  useEffect(() => {
    if (q.data && !v) setV(q.data.settings);
  }, [q.data, v]);
  const save = useMutation({
    mutationFn: (s: NpsSettings) => {
      const { updatedAt: _u, ...body } = s;
      return api.put<Payload>("/nps/settings", body);
    },
    onSuccess: () => {
      toast(t("saved"));
      void cache.invalidateQueries({ queryKey: NPS_KEY });
      onClose();
    },
  });
  const set = <K extends keyof NpsSettings>(k: K, val: NpsSettings[K]) => setV((x) => (x ? { ...x, [k]: val } : x));
  const edit = !!q.data?.canEdit;
  const eligible = v && q.data ? q.data.eligible[v.audience] : 0;
  const perMonth = v ? Math.round((eligible * v.samplePct) / 100 / Math.max(1, v.repeatDays / 30)) : 0;
  const opts = (list: number[], cur: number, label: (n: number) => string) => [...new Set([...list, cur])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{label(n)}</option>);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title")} description={t("desc")}>
      {q.isPending || !v ? (
        q.error ? <ErrorBlock error={q.error} retry={() => void q.refetch()} /> : <LoadingState />
      ) : (
        <form
          className="dialog-body"
          onSubmit={(e) => {
            e.preventDefault();
            if (edit) save.mutate(v);
          }}
        >
          <fieldset className={styles.fieldset} disabled={!edit}>
            <div className="row">
              <Switch checked={v.enabled} onChange={(x) => set("enabled", x)} label={t("enabled")} disabled={!edit} />
              <span>{t("enabled")}</span>
            </div>
            <h3 className={styles.h}>{t("who")}</h3>
            <div className={styles.opts2} role="radiogroup" aria-label={t("who")}>
              {(["admins", "members"] as const).map((a) => (
                <label key={a} className={v.audience === a ? "opt opt-on" : "opt"}>
                  <input type="radio" name="nps-audience" checked={v.audience === a} onChange={() => set("audience", a)} />
                  <span>
                    <b>{t(a)}</b>
                    <span className="cell-sub">{t(`${a}Desc`)}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="grid-2">
              <Select label={t("firstAfter")} value={v.firstAfterDays} onChange={(e) => set("firstAfterDays", Number(e.target.value))}>
                {opts(FIRST, v.firstAfterDays, (n) => t("days", { n }))}
              </Select>
              <Select label={t("repeat")} value={v.repeatDays} onChange={(e) => set("repeatDays", Number(e.target.value))}>
                {opts(REPEAT, v.repeatDays, (n) => t("repeatValue", { n }))}
              </Select>
              <Select label={t("sample")} value={v.samplePct} onChange={(e) => set("samplePct", Number(e.target.value))}>
                {opts(SAMPLE, v.samplePct, (n) => t("sampleValue", { n }))}
              </Select>
              <Input label={t("cap")} value={t("capValue")} readOnly disabled />
            </div>
            <h3 className={styles.h}>{t("skip")}</h3>
            <label className="check">
              <input type="checkbox" checked={v.excludeTrialDays !== null} onChange={(e) => set("excludeTrialDays", e.target.checked ? 14 : null)} />
              <span>{t("skipTrial", { n: v.excludeTrialDays ?? 14 })}</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={v.excludeTicketDays !== null} onChange={(e) => set("excludeTicketDays", e.target.checked ? 7 : null)} />
              <span>{t("skipTicket", { n: v.excludeTicketDays ?? 7 })}</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={v.excludeSpotlightDay} onChange={(e) => set("excludeSpotlightDay", e.target.checked)} />
              <span>{t("skipSpotlight")}</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={v.excludeShortMobile} onChange={(e) => set("excludeShortMobile", e.target.checked)} />
              <span>{t("skipMobile")}</span>
            </label>
            <Textarea label={`${t("question")} *`} rows={2} maxLength={200} value={v.question} onChange={(e) => set("question", e.target.value)} hint={t("questionHint")} />
            <details className={styles.details}>
              <summary>{t("followUps")}</summary>
              {(["detractor", "passive", "promoter"] as const).map((g) => (
                <Input key={g} label={t(g)} maxLength={200} value={v.followUps[g]} onChange={(e) => set("followUps", { ...v.followUps, [g]: e.target.value })} />
              ))}
            </details>
            <Notice tone="info">{t.rich("estimate", { b: (c) => <b>{c}</b>, perMonth, eligible, who: v.audience === "admins" ? t("whoAdmins") : t("whoMembers") })}</Notice>
          </fieldset>
          {!edit && <p className="muted small">{t("readOnly")}</p>}
          <InlineError error={save.error} />
          <div className="dialog-actions">
            <Button onClick={onClose}>{t("cancel")}</Button>
            {edit && (
              <Button type="submit" variant="primary" disabled={save.isPending || v.question.trim().length < 5}>
                {t("save")}
              </Button>
            )}
          </div>
        </form>
      )}
    </Modal>
  );
}
