"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useApprovalFlow } from "@/components/dialogs";
import { Modal, Notice, Seg } from "@/components/kit";
import { Button, InlineError, Input, LoadingState, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { type Change, type Key, type Matrix, PLAN_NAME, type PlanCode, useShow, type Value } from "./types";

interface Preview {
  fromVersion: number;
  nextVersion: number;
  changes: Change[];
  affected: { plan: PlanCode; key: string; from: Value; to: Value; workspaces: number; examples: { id: string; name: string }[] }[];
  affectedTotal: number;
  /** S9 · รายชื่อลูกค้าที่ถูกกระทบครบทุกราย (ops-api ก่อน O43 ไม่มี) */
  affectedWorkspaces?: { id: string; name: string; slug: string; plan: PlanCode; keys: string[] }[];
  /** ต้องแจ้งลูกค้าล่วงหน้าอย่างน้อยกี่วัน */
  noticeDays?: number;
}
/** ตัวแปรชื่อ Workspace ของประกาศ (announcements.service.ts › WS_VAR) */
const WS_VAR = "{ชื่อ Workspace}";
const DAY = 86_400_000;

/**
 * P2 · บันทึกสิทธิ์เป็นเวอร์ชันใหม่ · นับลูกค้าที่ถูกลดสิทธิ์ก่อนส่ง · ต้องมีคนอนุมัติเสมอ
 * S9: รายชื่อลูกค้าที่ถูกกระทบครบ · ร่างประกาศ C8 ไปกับคำขออนุมัติ (ส่งเมื่ออนุมัติ) · ตรวจแจ้งล่วงหน้า ≥ 30 วัน
 */
export function SaveVersion({ draft, current, keys, onClose, onSent }: { draft: Matrix; current: Matrix; keys: Key[]; onClose: () => void; onSent: () => void }) {
  const t = useTranslations("ent");
  const tc = useTranslations("common.dialog");
  const show = useShow();
  const cache = useQueryClient();
  const { handle } = useApprovalFlow();
  const [when, setWhen] = useState<"now" | "scheduled">("now");
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [announce, setAnnounce] = useState(false);
  const [annTitle, setAnnTitle] = useState("");
  const [annMessage, setAnnMessage] = useState("");
  const preview = useQuery({ queryKey: ["ops", "entitlements", "preview", draft], queryFn: () => api.post<Preview>("/entitlements/preview", { matrix: draft }), staleTime: 0 });
  const unitOf = (key: string) => keys.find((k) => k.key === key)?.unit;
  // วันที่มีผลเริ่ม 00:00 เวลาไทยของวันนั้น
  const effectiveAt = when === "scheduled" && date ? `${date}T00:00:00+07:00` : null;
  const annOk = !announce || (!!annTitle.trim() && !!annMessage.trim());
  const ok = reason.trim().length >= 3 && (when === "now" || !!date) && !!preview.data?.changes.length && annOk;
  const m = useMutation({
    mutationFn: () =>
      api
        .post("/entitlements/versions", { matrix: draft, effectiveAt, reason: reason.trim(), ...(announce ? { announcement: { title: annTitle.trim(), message: annMessage.trim() } } : {}) })
        .then(handle),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["ops"] });
      onSent();
    },
  });
  const p = preview.data;
  const list = p?.affectedWorkspaces;
  const reduces = !!p?.affected.length;
  const hurt = list ? list.length : (p?.affectedTotal ?? 0);
  const minNotice = p?.noticeDays ?? 30;
  // วันที่มีผลห่างจากวันนี้ (ปัดลงเหมือน ops-api) · ทันที = ยังไม่ได้แจ้งล่วงหน้า
  const days = effectiveAt ? Math.floor((new Date(effectiveAt).getTime() - Date.now()) / DAY) : null;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      className="dialog-wide"
      title={p ? t("save.title", { version: p.nextVersion }) : t("saveVersion")}
      description={p ? t("save.desc", { count: p.changes.length }) : undefined}
    >
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        {preview.isPending ? (
          <LoadingState />
        ) : preview.error ? (
          <InlineError error={preview.error} />
        ) : (
          p && (
            <>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th scope="col">{t("save.col.item")}</th>
                      <th scope="col">{t("save.col.plan")}</th>
                      <th scope="col" className="num">
                        {t("save.col.from")}
                      </th>
                      <th scope="col" className="num">
                        {t("save.col.to")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.changes.map((c) => (
                      <tr key={`${c.plan}:${c.key}`}>
                        <td>{t(`keys.${c.key}` as "keys.seats")}</td>
                        <td>{PLAN_NAME[c.plan]}</td>
                        <td className="num muted">{show(c.key, c.from, { plan: c.plan, unit: unitOf(c.key) })}</td>
                        <td className={c.reduced ? "num cell-strong" : "num"}>{show(c.key, c.to, { plan: c.plan, unit: unitOf(c.key) })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {reduces && (
                <dl className="promo-kv">
                  <dt>{t("save.affectedLabel")}</dt>
                  <dd>
                    {hurt ? t.rich("save.affectedSum", { count: hurt, b: (c) => <b>{c}</b> }) : t("save.affectedNoneSum")}
                    {!!list?.length && (
                      <>
                        {" · "}
                        <button type="button" className="link-button" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
                          {showAll ? t("save.hideAll") : t("save.viewAll")}
                        </button>
                      </>
                    )}
                  </dd>
                  <dt>{t("save.approverLabel")}</dt>
                  <dd>{t("save.approverReduce")}</dd>
                </dl>
              )}
              {showAll && list && (
                <ul className="small" aria-label={t("save.listLabel")} style={{ maxHeight: 200, overflow: "auto", margin: 0, paddingLeft: 20 }}>
                  {list.map((w) => (
                    <li key={w.id}>
                      {w.name} · {PLAN_NAME[w.plan]} · <span className="muted">{w.keys.map((k) => t(`keys.${k}` as "keys.seats")).join(", ")}</span>
                    </li>
                  ))}
                </ul>
              )}
              {p.affected.map((a) => (
                <Notice key={`${a.plan}:${a.key}`} tone={a.workspaces ? "warn" : "info"} title={t("save.reduced", { key: t(`keys.${a.key}` as "keys.seats"), plan: PLAN_NAME[a.plan] })}>
                  {a.workspaces ? t("save.affected", { count: a.workspaces }) : t("save.affectedNone")}
                  {a.examples.length > 0 && ` · ${a.examples.map((x) => x.name).join(", ")}`}
                </Notice>
              ))}
            </>
          )
        )}
        <Seg label={t("save.effective")} value={when} onChange={setWhen} options={[{ value: "now", label: t("save.now") }, { value: "scheduled", label: t("save.scheduled") }]} />
        {when === "scheduled" && <Input type="date" label={t("save.effectiveDate")} value={date} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} />}
        <p className="muted small">{t("save.grace")}</p>
        {p && reduces && (
          <>
            <label className="check">
              <input type="checkbox" checked={announce} onChange={(e) => setAnnounce(e.target.checked)} disabled={!hurt} />
              <span>
                <b>{t("save.announce")}</b>
                <span className="muted small" style={{ display: "block" }}>
                  {t("save.announceHint")}
                </span>
              </span>
            </label>
            {announce && (
              <div className="stack" style={{ paddingLeft: 28 }}>
                <Input label={`${t("save.announceTitle")} *`} value={annTitle} maxLength={150} onChange={(e) => setAnnTitle(e.target.value)} />
                <Textarea label={`${t("save.announceMessage")} *`} value={annMessage} maxLength={2000} rows={3} onChange={(e) => setAnnMessage(e.target.value)} hint={t("save.announceVar", { var: WS_VAR })} />
              </div>
            )}
            <Notice tone={days != null && days >= minNotice ? "ok" : "warn"}>
              {days == null ? t("save.noticeNow", { min: minNotice }) : days >= minNotice ? t("save.noticeOk", { min: minNotice, days }) : t("save.noticeShort", { min: minNotice, days })}
            </Notice>
          </>
        )}
        <Textarea label={t("save.reason")} value={reason} onChange={(e) => setReason(e.target.value)} required />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!ok || m.isPending}>
            {t("save.submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
