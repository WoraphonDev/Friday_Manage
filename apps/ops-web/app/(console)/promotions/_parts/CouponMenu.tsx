"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ConfirmDialog, useApprovalFlow, useReauth } from "@/components/dialogs";
import { Drawer, Empty, ErrorBlock, Modal, Popover, TableSkeleton } from "@/components/kit";
import { Button, errorToast, InlineError, Input, Pill, type Tone, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useFmt } from "../../workspaces/_parts/format";
import { type Coupon, PROMO_KEY, type Redemption, useCouponText } from "./types";

export type CouponAction = { kind: "edit"; coupon: Coupon } | { kind: "copy"; coupon: Coupon };

/** P4 · ตั้งค่าคูปองที่ใช้อยู่ (Popover จากปุ่ม "ตั้งค่า" ในแถวคูปอง) */
export function CouponMenu({ coupon, canWrite, onOpen }: { coupon: Coupon; canWrite: boolean; onOpen: (a: CouponAction) => void }) {
  const t = useTranslations("promo");
  const text = useCouponText();
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const { handle } = useApprovalFlow();
  const [dialog, setDialog] = useState<"expiry" | "disable" | "customers" | null>(null);
  const activate = useMutation({
    mutationFn: () => run(() => api.post<{ coupon?: Coupon; pendingApproval?: unknown }>(`/promotions/coupons/${coupon.id}/activate`, {}), t("menu.activate")).then(handle),
    onSuccess: (r) => {
      if (!r.pendingApproval) toast(t("activated", { code: coupon.code }));
      void cache.invalidateQueries({ queryKey: PROMO_KEY });
    },
    onError: (e) => toast(errorToast(e)),
  });
  const people = coupon.used + coupon.pending;
  return (
    <>
      <Popover
        label={t("menu.label", { code: coupon.code })}
        trigger={({ open, toggle }) => (
          <Button size="small" aria-expanded={open} aria-haspopup="menu" aria-label={t("menu.label", { code: coupon.code })} onClick={toggle}>
            {t("menu.open")}
          </Button>
        )}
      >
        {(close) => (
          <div className="stack-tight" role="menu">
            {canWrite && coupon.status !== "disabled" && (
              <button type="button" role="menuitem" className="menu-item" onClick={() => (close(), setDialog("expiry"))}>
                <span className="stack-tight">
                  <span>{t("menu.expiry")}</span>
                  <span className="muted small">{t("menu.expiryNow", { code: coupon.code, date: coupon.expiresOn ? text.day(coupon.expiresOn) : t("coupons.noExpiry") })}</span>
                </span>
              </button>
            )}
            {canWrite && coupon.status === "draft" && (
              <button type="button" role="menuitem" className="menu-item" onClick={() => (close(), onOpen({ kind: "edit", coupon }))}>
                {t("menu.editDraft")}
              </button>
            )}
            {canWrite && (
              <button type="button" role="menuitem" className="menu-item" onClick={() => (close(), onOpen({ kind: "copy", coupon }))}>
                {t("menu.copy")}
              </button>
            )}
            <button type="button" role="menuitem" className="menu-item" onClick={() => (close(), setDialog("customers"))}>
              {t("menu.customers", { count: people })}
            </button>
            {canWrite && coupon.status !== "active" && !coupon.pendingApproval && (
              <button type="button" role="menuitem" className="menu-item" disabled={activate.isPending} onClick={() => (close(), activate.mutate())}>
                {t("menu.activate")}
              </button>
            )}
            {canWrite && coupon.status === "active" && (
              <button type="button" role="menuitem" className="menu-item" onClick={() => (close(), setDialog("disable"))}>
                <span className="stack-tight">
                  <span className="text-danger">{t("menu.disable")}</span>
                  <span className="muted small">{t("menu.disableHint")}</span>
                </span>
              </button>
            )}
          </div>
        )}
      </Popover>
      {dialog === "expiry" && <ExpiryDialog coupon={coupon} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={dialog === "disable"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t("disable.title", { code: coupon.code })}
        description={t("disable.desc")}
        confirmLabel={t("disable.confirm")}
        danger
        onConfirm={async ({ reason }) => {
          await api.post(`/promotions/coupons/${coupon.id}/disable`, { reason });
          toast(t("disable.done", { code: coupon.code }));
          void cache.invalidateQueries({ queryKey: PROMO_KEY });
        }}
      />
      <RedemptionsDrawer coupon={coupon} open={dialog === "customers"} onOpenChange={(o) => !o && setDialog(null)} />
    </>
  );
}

/** แก้วันหมดอายุ · เว้นว่าง = ไม่หมดอายุ */
function ExpiryDialog({ coupon, onClose }: { coupon: Coupon; onClose: () => void }) {
  const t = useTranslations("promo.expiry");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [date, setDate] = useState(coupon.expiresOn ?? "");
  const m = useMutation({
    mutationFn: () => api.patch(`/promotions/coupons/${coupon.id}`, { expiresOn: date || null }),
    onSuccess: () => {
      toast(t("done"));
      void cache.invalidateQueries({ queryKey: PROMO_KEY });
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title", { code: coupon.code })}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
        <Input label={t("date")} type="date" value={date} onChange={(e) => setDate(e.target.value)} hint={t("hint")} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={m.isPending}>
            {t("save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const STATUS_TONE: Record<Redemption["status"], Tone> = { pending: "warn", active: "ok", ended: "neu" };

/** ดูลูกค้าที่ใช้คูปอง · รอบที่ใช้ไป ส่วนลดรวม และจ่ายต่อหลังหมดส่วนลดไหม */
function RedemptionsDrawer({ coupon, open, onOpenChange }: { coupon: Coupon; open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useTranslations("promo.redemptions");
  const fmt = useFmt();
  const q = useQuery({ queryKey: [...PROMO_KEY, "redemptions", coupon.id], queryFn: () => api.get<{ items: Redemption[] }>(`/promotions/coupons/${coupon.id}/redemptions`), enabled: open });
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title={t("title", { code: coupon.code })} description={t("desc")} wide>
      {q.isPending ? (
        <TableSkeleton rows={3} cols={5} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !q.data.items.length ? (
        <Empty title={t("empty")} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">{t("col.workspace")}</th>
                <th scope="col">{t("col.status")}</th>
                <th scope="col" className="num">
                  {t("col.cycles")}
                </th>
                <th scope="col" className="num">
                  {t("col.discount")}
                </th>
                <th scope="col">{t("col.kept")}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((r) => (
                <tr key={r.workspace.id}>
                  <td>
                    <Link href={`/workspaces/${r.workspace.id}`} className="cell-main">
                      {r.workspace.name}
                    </Link>
                    <span className="cell-sub mono" style={{ display: "block" }}>
                      {r.workspace.slug} · {fmt.date(r.createdAt)}
                    </span>
                  </td>
                  <td>
                    <Pill tone={STATUS_TONE[r.status]}>{t(`status.${r.status}`)}</Pill>
                  </td>
                  <td className="num">{t("cycles", { used: r.cyclesUsed, total: r.cyclesTotal ?? t("forever") })}</td>
                  <td className="num">{fmt.money(r.discountSatang)}</td>
                  <td>{r.keptPaying === null ? "—" : r.keptPaying ? <Pill tone="ok">{t("kept")}</Pill> : <Pill>{t("left")}</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Drawer>
  );
}
