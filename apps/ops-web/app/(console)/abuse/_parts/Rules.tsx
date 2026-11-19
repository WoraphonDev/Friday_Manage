"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useReauth } from "@/components/dialogs";
import { ErrorBlock, Switch, TableSkeleton } from "@/components/kit";
import { Button, errorToast, InlineError, Input, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import styles from "../abuse.module.css";
import { ABUSE_KEY } from "./types";

interface Rule {
  key: string;
  points: number;
  on: boolean;
  waiting: "A35b" | "geoip" | null;
  hits7d: number;
  falsePositivePct: number | null;
}
interface Rules {
  review: number;
  autoSuspend: number;
  rules: Rule[];
}
/** % จับผิดตั้งแต่ระดับนี้ = ควรลดคะแนน (storyboard ขั้น 3) */
const FP_HIGH = 30;

/** ปุ่มเฟือง: เกณฑ์ + กฎ · แต่ละกฎบอกจำนวนที่เจอ 7 วันและ % ที่คนตัดสินว่าไม่ใช่การใช้ผิด */
export function RulesPanel() {
  const t = useTranslations("abuse.rules");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const q = useQuery({ queryKey: [...ABUSE_KEY, "rules"], queryFn: () => api.get<Rules>("/abuse/rules") });
  const [draft, setDraft] = useState<Rules | null>(null);
  useEffect(() => {
    if (q.data && !draft) setDraft(q.data);
  }, [q.data, draft]);
  const save = useMutation({
    mutationFn: (d: Rules) =>
      run(() => api.put<Rules & { saved: boolean }>("/abuse/rules", { review: d.review, autoSuspend: d.autoSuspend, rules: Object.fromEntries(d.rules.map((r) => [r.key, { points: r.points, on: r.on }])) }), t("title")),
    onSuccess: (r) => {
      toast(r.saved ? t("saved") : t("noChange"));
      setDraft(r);
      void cache.invalidateQueries({ queryKey: ABUSE_KEY });
    },
    onError: (e) => toast(errorToast(e)),
  });
  if (q.isPending || !draft) return q.error ? <ErrorBlock error={q.error} retry={() => void q.refetch()} /> : <TableSkeleton rows={6} cols={5} />;
  const setRule = (key: string, patch: Partial<Rule>) => setDraft({ ...draft, rules: draft.rules.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
  const num = (v: string) => (v === "" ? 0 : Math.max(0, Math.round(Number(v))));
  return (
    <form className="stack" onSubmit={(e) => (e.preventDefault(), save.mutate(draft))}>
      <div className={styles.thresholds}>
        <Input label={t("review")} type="number" min={10} max={500} value={draft.review} onChange={(e) => setDraft({ ...draft, review: num(e.target.value) })} />
        <Input label={t("autoSuspend")} type="number" min={11} max={999} value={draft.autoSuspend} onChange={(e) => setDraft({ ...draft, autoSuspend: num(e.target.value) })} />
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th scope="col">{t("signal")}</th>
              <th scope="col" className="num">
                {t("points")}
              </th>
              <th scope="col" className="num">
                {t("hits")}
              </th>
              <th scope="col" className="num">
                {t("fp")}
              </th>
              <th scope="col">{t("on")}</th>
            </tr>
          </thead>
          <tbody>
            {draft.rules.map((r) => {
              const name = t(`names.${r.key}` as "names.temp_email");
              return (
                <tr key={r.key}>
                  <td>
                    {name}
                    {r.waiting && <div className="cell-sub">{t(`waiting.${r.waiting}`)}</div>}
                  </td>
                  <td className="num">
                    <input className={`input ${styles.pointsInput}`} type="number" min={0} max={100} aria-label={`${t("points")} ${name}`} value={r.points} onChange={(e) => setRule(r.key, { points: Math.min(100, num(e.target.value)) })} />
                  </td>
                  <td className="num">{r.hits7d}</td>
                  <td className="num">
                    {r.falsePositivePct == null ? (
                      "—"
                    ) : (
                      <span className={r.falsePositivePct >= FP_HIGH ? styles.fpHigh : undefined} title={r.falsePositivePct >= FP_HIGH ? t("fpHigh") : undefined}>
                        {r.falsePositivePct}%
                      </span>
                    )}
                  </td>
                  <td>
                    <Switch checked={r.on} disabled={!!r.waiting} label={`${t("on")} ${name}`} onChange={(v) => setRule(r.key, { on: v })} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <InlineError error={save.error} />
      <div className="dialog-actions">
        <Button type="button" onClick={() => setDraft(q.data ?? null)}>
          {tc("cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}
