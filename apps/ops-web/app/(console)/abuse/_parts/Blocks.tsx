"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useReauth } from "@/components/dialogs";
import { Empty, ErrorBlock, Modal, Pager, TableSkeleton } from "@/components/kit";
import { Button, errorToast, InlineError, Input, Select, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useFmt } from "../../workspaces/_parts/format";
import { ABUSE_KEY, type BlockKind } from "./types";

interface Block {
  id: string;
  kind: BlockKind;
  value: string;
  label: string | null;
  reason: string;
  expiresAt: string | null;
  createdAt: string;
  createdBy: string;
  caseNumber: number | null;
}
const PAGE = 50;
/** เพิ่มเองจากหน้านี้ได้ 3 ชนิด · API token บล็อกจากหน้า Rate limit (O51) ที่รู้ว่า token ไหน */
const ADDABLE = ["email_domain", "ip", "workspace_slug"] as const;
const EXPIRY = ["", "7", "30", "90", "365"] as const;

/** แท็บรายชื่อที่ถูกบล็อก · ค้นและแบ่งหน้าที่ ops-api (จะมีหลักพันรายการ) */
export function BlocksTab({ q, kind, adding, onAdding }: { q: string; kind: string; adding: boolean; onAdding: (v: boolean) => void }) {
  const t = useTranslations("abuse");
  const fmt = useFmt();
  const [offset, setOffset] = useState(0);
  const [removing, setRemoving] = useState<Block | null>(null);
  const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset), ...(q ? { q } : {}), ...(kind ? { kind } : {}) });
  const list = useQuery({ queryKey: [...ABUSE_KEY, "blocks", qs.toString()], queryFn: () => api.get<{ items: Block[]; total: number }>(`/abuse/blocks?${qs}`), placeholderData: keepPreviousData });
  return (
    <>
      {list.isPending ? (
        <TableSkeleton rows={5} cols={6} />
      ) : list.error ? (
        <ErrorBlock error={list.error} retry={() => void list.refetch()} />
      ) : !list.data.items.length ? (
        <Empty title={q || kind ? t("blocks.emptySearch") : t("blocks.empty")} />
      ) : (
        <>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{t("blocks.kind")}</th>
                  <th scope="col">{t("col.value")}</th>
                  <th scope="col">{t("col.reason")}</th>
                  <th scope="col">{t("col.expires")}</th>
                  <th scope="col">{t("col.addedBy")}</th>
                  <th scope="col">
                    <span className="sr-only">{t("blocks.remove")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((b) => (
                  <tr key={b.id}>
                    <td>{t(`blocks.kinds.${b.kind}`)}</td>
                    <td className="mono">{b.label ?? b.value}</td>
                    <td className="small">
                      {b.reason}
                      {b.caseNumber != null && <div className="cell-sub">{t("blocks.fromCase", { n: b.caseNumber })}</div>}
                    </td>
                    <td className="small">{b.expiresAt ? fmt.date(b.expiresAt) : t("blocks.forever")}</td>
                    <td className="small">
                      {b.createdBy}
                      <div className="cell-sub">{fmt.date(b.createdAt)}</div>
                    </td>
                    <td className="num">
                      <Button size="small" variant="ghost" onClick={() => setRemoving(b)}>
                        {t("blocks.remove")}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager offset={offset} limit={PAGE} shown={list.data.items.length} total={list.data.total} onChange={setOffset} />
        </>
      )}
      {adding && <AddBlock onClose={() => onAdding(false)} />}
      {removing && <RemoveBlock block={removing} onClose={() => setRemoving(null)} />}
    </>
  );
}

function AddBlock({ onClose }: { onClose: () => void }) {
  const t = useTranslations("abuse.blocks");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const [kind, setKind] = useState<(typeof ADDABLE)[number]>("email_domain");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [days, setDays] = useState<(typeof EXPIRY)[number]>("");
  const m = useMutation({
    mutationFn: () =>
      run(
        () => api.post("/abuse/blocks", { kind, value: value.trim(), reason: reason.trim(), expiresAt: days ? new Date(Date.now() + Number(days) * 86_400_000).toISOString() : null }),
        t("addTitle"),
      ),
    onSuccess: () => (toast(t("added")), void cache.invalidateQueries({ queryKey: ABUSE_KEY }), onClose()),
  });
  const ok = value.trim().length > 0 && reason.trim().length >= 3 && !m.isPending;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("addTitle")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <Select label={t("kind")} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          {ADDABLE.map((k) => (
            <option key={k} value={k}>
              {t(`kinds.${k}`)}
            </option>
          ))}
        </Select>
        <Input label={t("value")} hint={t(`valueHint.${kind}`)} value={value} onChange={(e) => setValue(e.target.value)} />
        <Select label={t("expires")} value={days} onChange={(e) => setDays(e.target.value as typeof days)}>
          {EXPIRY.map((d) => (
            <option key={d} value={d}>
              {d ? t("days", { n: d }) : t("forever")}
            </option>
          ))}
        </Select>
        <Textarea label={tc("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!ok}>
            {t("add")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RemoveBlock({ block, onClose }: { block: Block; onClose: () => void }) {
  const t = useTranslations("abuse.blocks");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => run(() => api.post(`/abuse/blocks/${block.id}/remove`, { reason: reason.trim() }), t("remove")),
    onSuccess: () => (toast(t("removed")), void cache.invalidateQueries({ queryKey: ABUSE_KEY }), onClose()),
    onError: (e) => toast(errorToast(e)),
  });
  const ok = reason.trim().length >= 3 && !m.isPending;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("removeTitle", { value: block.label ?? block.value })}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <Textarea label={tc("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="danger" disabled={!ok}>
            {t("remove")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
