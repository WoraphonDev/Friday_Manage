"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FileImage, FileViewer } from "@/components/file-viewer";
import { Drawer, ErrorBlock, TableSkeleton } from "@/components/kit";
import { Kbd } from "@/components/shortcut-help";
import { Button, errorToast, InlineError, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { defer, UNDO_MS } from "@/lib/outbox";
import { type Seen, usePresence } from "@/lib/presence";
import { useShortcuts } from "@/lib/shortcuts";
import { useFmt } from "../../workspaces/_parts/format";

export interface RunSlip {
  id: string;
  method: string;
  amount: number;
  createdAt: string;
  invoice: { id: string; number: string; amountDue: number };
  workspace: { id: string; name: string };
}
/** เหตุผลที่ไม่ผ่าน (ปุ่ม 1–4) · ข้อความถึงลูกค้าเติมให้ตามเหตุผล แก้ได้ก่อนส่ง */
const REASONS = ["amount", "account", "duplicate", "unreadable"] as const;
type Reason = (typeof REASONS)[number];

/**
 * ตรวจสลิปต่อเนื่อง (ช่วง 2): สลิปใหญ่ซ้าย ยอดที่ต้องได้ขวา · A ผ่าน · X ไม่ตรง (เลือกเหตุผลก่อนเสมอ) · S ข้าม · Esc หยุด
 * ผ่าน = ไปใบถัดไปทันที ส่งจริงหลัง 10 วินาที (ย้อนกลับได้) · สลิปที่เพื่อนเปิดอยู่ถูกข้ามให้
 */
export function SlipRun({ onClose }: { onClose: () => void }) {
  const t = useTranslations("money.run");
  const tv = useTranslations("money.verify");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const queue = useQuery({
    queryKey: ["ops", "payments", "run"],
    queryFn: () => api.get<{ items: RunSlip[]; total: number }>("/payments?status=pending_review&queue=slips&limit=200"),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const items = queue.data?.items ?? [];
  const [i, setI] = useState(0);
  const [skipped, setSkipped] = useState<(RunSlip & { by?: string })[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [counts, setCounts] = useState({ passed: 0, rejected: 0 });
  const [started] = useState(() => Date.now());
  const [rejecting, setRejecting] = useState<Reason | null>(null);
  const [message, setMessage] = useState("");
  const [viewing, setViewing] = useState(false);
  const cur = items[i] as RunSlip | undefined;
  const finished = !!queue.data && i >= items.length;
  usePresence("payment", cur?.id ?? null);

  // ไปใบถัดไปที่ไม่มีเพื่อนเปิดอยู่
  const goTo = async (from: number, extra: RunSlip[] = []) => {
    const rest = items.slice(from, from + 50);
    const seen = rest.length ? (await api.get<{ items: Seen[] }>(`/presence?type=payment&ids=${rest.map((x) => x.id).join(",")}`).catch(() => ({ items: [] as Seen[] }))).items : [];
    const busy = new Map(seen.map((x) => [x.id, x.name]));
    let n = from;
    const now: (RunSlip & { by?: string })[] = [];
    while (n < items.length && busy.has(items[n].id)) now.push({ ...items[n], by: busy.get(items[n].id) }), n++;
    setSkipped((s) => [...s, ...extra, ...now]);
    setNote(now.length ? t("skippedViewed", { numbers: now.map((x) => x.invoice.number).join(", "), name: now[0].by ?? "" }) : null);
    setRejecting(null);
    setMessage("");
    setI(n);
  };
  const done = () => void cache.invalidateQueries({ queryKey: ["ops"] });
  const pass = () => {
    if (!cur) return;
    const slip = cur;
    const at = i;
    // ข้อ 2 ก: ใบที่ตรงครบไม่ถามยืนยัน · ส่งจริงหลัง 10 วินาที ย้อนกลับได้
    const job = defer(`payment:${slip.id}`, () => api.post(`/payments/${slip.id}/confirm`, {}).then(done), (e) => toast(errorToast(e)));
    setCounts((c) => ({ ...c, passed: c.passed + 1 }));
    toast({
      message: t("passed", { number: slip.invoice.number, amount: fmt.money(slip.amount) }),
      duration: UNDO_MS,
      undo: () => {
        if (!job.cancel()) return;
        setCounts((c) => ({ ...c, passed: Math.max(0, c.passed - 1) }));
        setNote(null);
        setI(at);
      },
    });
    void goTo(i + 1);
  };
  const reject = useMutation({
    mutationFn: () => api.post(`/payments/${cur!.id}/reject`, { reason: t(`reasons.${rejecting!}`), message: message.trim() }),
    onSuccess: () => (done(), setCounts((c) => ({ ...c, rejected: c.rejected + 1 })), void goTo(i + 1)),
  });
  const choose = (r: Reason) => {
    if (!cur) return;
    setRejecting(r);
    setMessage(t(`messages.${r}`, { diff: fmt.money(Math.abs(cur.invoice.amountDue - cur.amount)), number: cur.invoice.number }));
  };
  const busy = !cur || finished || viewing;
  useShortcuts([
    { keys: "a", label: tv("pass"), run: () => !busy && !rejecting && pass() },
    { keys: "x", label: t("reject"), run: () => !busy && choose("amount") },
    { keys: "s", label: t("skip"), run: () => !busy && void goTo(i + 1, [cur!]) },
    ...REASONS.map((r, n) => ({ keys: String(n + 1), run: () => rejecting && choose(r) })),
    { keys: "mod+enter", inInput: true, run: () => rejecting && message.trim().length >= 3 && !reject.isPending && reject.mutate() },
  ]);

  const diff = cur ? cur.amount - cur.invoice.amountDue : 0;
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={t("title")} className="drawer-run">
      {queue.isPending ? (
        <TableSkeleton rows={4} cols={2} />
      ) : queue.error ? (
        <ErrorBlock error={queue.error} retry={() => void queue.refetch()} />
      ) : finished ? (
        <div className="stack">
          <h3 className="card-title">{t("doneTitle", { n: items.length })}</h3>
          <div className="run-stats">
            <div>
              <span className="muted small">{t("passedCount")}</span>
              <b>{counts.passed}</b>
            </div>
            <div>
              <span className="muted small">{t("rejectedCount")}</span>
              <b>{counts.rejected}</b>
            </div>
            <div>
              <span className="muted small">{t("skippedCount")}</span>
              <b>{skipped.length}</b>
            </div>
          </div>
          <p className="muted small">{t("took", { minutes: Math.max(1, Math.round((Date.now() - started) / 60_000)) })}</p>
          <div className="row">
            <Button onClick={onClose}>{t("back")}</Button>
          </div>
        </div>
      ) : (
        cur && (
          <>
            <div className="run-bar" role="status" style={{ margin: "0 -22px" }}>
              <span className="muted small">{t("progress", { pos: i + 1, total: queue.data!.total })}</span>
              <span className="run-progress" aria-hidden="true">
                <i style={{ width: `${Math.round(((i + 1) / items.length) * 100)}%` }} />
              </span>
              <Button size="small" onClick={onClose}>
                {t("stop")} <Kbd keys="escape" />
              </Button>
              {note && <span className="run-note">{note}</span>}
            </div>
            <div className="run-grid">
              <FileImage path={`/payments/${cur.id}/slip`} alt={tv("slipThumb")} onOpen={() => setViewing(true)} />
              <section className="stack">
                <h3 className="card-title">
                  {cur.workspace.name} · <span className="mono">{cur.invoice.number}</span>
                </h3>
                <table className="tbl">
                  <tbody>
                    <tr>
                      <td className="muted">{tv("col.expected")}</td>
                      <td className="num">
                        <b>{fmt.money(cur.invoice.amountDue)}</b>
                      </td>
                    </tr>
                    <tr>
                      <td className="muted">{t("inSlip")}</td>
                      <td className="num">
                        <b>{fmt.money(cur.amount)}</b> {diff === 0 ? <span className="pill ok">{t("match")}</span> : <span className="pill bad">{diff < 0 ? t("short", { n: fmt.money(-diff) }) : t("over", { n: fmt.money(diff) })}</span>}
                      </td>
                    </tr>
                    <tr>
                      <td className="muted">{tv("col.channel")}</td>
                      <td className="num">{tv(`methods.${cur.method}` as "methods.transfer")}</td>
                    </tr>
                    <tr>
                      <td className="muted">{tv("uploaded")}</td>
                      <td className="num">{fmt.dateTime(cur.createdAt)}</td>
                    </tr>
                  </tbody>
                </table>
                {rejecting ? (
                  <form className="stack" onSubmit={(e) => (e.preventDefault(), message.trim().length >= 3 && reject.mutate())}>
                    <b className="small">{t("whyReject")}</b>
                    <div className="reason-keys" role="group" aria-label={t("whyReject")}>
                      {REASONS.map((r, n) => (
                        <button key={r} type="button" className="chip" aria-pressed={rejecting === r} onClick={() => choose(r)}>
                          <Kbd keys={String(n + 1)} /> {t(`reasons.${r}`)}
                        </button>
                      ))}
                    </div>
                    <Textarea label={t("toCustomer")} value={message} onChange={(e) => setMessage(e.target.value)} />
                    <InlineError error={reject.error} />
                    <div className="row">
                      <Button onClick={() => setRejecting(null)}>{t("cancel")}</Button>
                      <span className="spacer" />
                      <Button type="submit" variant="primary" disabled={message.trim().length < 3 || reject.isPending}>
                        {t("rejectNext")} <Kbd keys="mod+enter" />
                      </Button>
                    </div>
                  </form>
                ) : (
                  <div className="row">
                    <Button onClick={() => choose(diff === 0 ? "account" : "amount")}>
                      {t("reject")} <Kbd keys="x" />
                    </Button>
                    <Button onClick={() => void goTo(i + 1, [cur])}>
                      {t("skip")} <Kbd keys="s" />
                    </Button>
                    <span className="spacer" />
                    <Button variant="primary" onClick={pass}>
                      {tv("pass")} <Kbd keys="a" />
                    </Button>
                  </div>
                )}
              </section>
            </div>
            {viewing && <FileViewer path={`/payments/${cur.id}/slip`} title={tv("slipTitle", { ws: cur.workspace.name })} filename={`slip-${cur.invoice.number}`} onClose={() => setViewing(false)} />}
          </>
        )
      )}
    </Drawer>
  );
}
