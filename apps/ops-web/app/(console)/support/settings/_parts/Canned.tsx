"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { Chip, Empty, ErrorBlock, Modal, TableSkeleton } from "@/components/kit";
import { Button, errorToast, InlineError, Input, Pill, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useFmt } from "../../../workspaces/_parts/format";
import { CANNED_KEY, type Canned, VARIABLES } from "./types";

/** ข้อความสำเร็จรูป (ใช้ใน T4) · Owner เพิ่ม/แก้/เลิกใช้ · เก็บที่เลิกใช้ไว้ดูย้อนหลัง */
export function CannedReplies({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations("sset.canned");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<Canned | "new" | null>(null);
  const q = useQuery({ queryKey: [...CANNED_KEY, archived], queryFn: () => api.get<{ items: Canned[] }>(`/support/canned-replies${archived ? "?archived=true" : ""}`) });
  const toggle = useMutation({
    mutationFn: (c: Canned) => api.post(`/support/canned-replies/${c.id}/${c.archivedAt ? "restore" : "archive"}`, {}),
    onSuccess: () => void cache.invalidateQueries({ queryKey: CANNED_KEY }),
    onError: (e) => toast(errorToast(e)),
  });
  return (
    <section className="card" id="canned">
      <div className="card-head">
        <div>
          <h2 className="card-title">{t("title")}</h2>
          <span className="card-sub">{t("sub")}</span>
        </div>
        <div className="row push-end">
          {canEdit && (
            <Chip pressed={archived} onClick={() => setArchived(!archived)}>
              {t("showArchived")}
            </Chip>
          )}
          {canEdit && (
            <Button onClick={() => setEditing("new")}>
              <Plus size={16} /> {t("add")}
            </Button>
          )}
        </div>
      </div>
      {q.isPending ? (
        <TableSkeleton rows={3} cols={4} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !q.data.items.length ? (
        <Empty title={t("empty")} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">{t("col.title")}</th>
                <th scope="col">{t("col.tag")}</th>
                <th scope="col" className="num">
                  {t("col.uses")}
                </th>
                <th scope="col">{t("col.updated")}</th>
                {canEdit && (
                  <th scope="col">
                    <span className="sr-only">{t("col.actions")}</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((c) => (
                <tr key={c.id} className={c.archivedAt ? "row-off" : undefined}>
                  <td className="cell-wrap">
                    <div className="cell-strong">
                      {c.title} {c.archivedAt && <Pill>{t("archived")}</Pill>}
                    </div>
                    <div className="cell-sub clamp-1">{c.body}</div>
                  </td>
                  <td>{c.tag ? <Pill tone="inf">{c.tag}</Pill> : <span className="muted">—</span>}</td>
                  <td className="num">{fmt.num(c.uses)}</td>
                  <td className="muted small">
                    {fmt.date(c.updatedAt)}
                    {c.updatedBy && ` · ${c.updatedBy}`}
                  </td>
                  {canEdit && (
                    <td>
                      <div className="row nowrap">
                        <Button size="icon" aria-label={t("edit", { title: c.title })} onClick={() => setEditing(c)}>
                          <Pencil size={14} />
                        </Button>
                        <Button size="small" disabled={toggle.isPending} onClick={() => toggle.mutate(c)}>
                          {c.archivedAt ? t("restore") : t("archive")}
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <CannedDialog item={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function CannedDialog({ item, onClose }: { item: Canned | null; onClose: () => void }) {
  const t = useTranslations("sset.canned");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [title, setTitle] = useState(item?.title ?? "");
  const [body, setBody] = useState(item?.body ?? "");
  const [tag, setTag] = useState(item?.tag ?? "");
  const sel = useRef<[number, number] | null>(null);
  const ok = title.trim().length >= 2 && body.trim().length >= 2;
  const m = useMutation({
    mutationFn: () => {
      const payload = { title: title.trim(), body: body.trim(), ...(tag.trim() ? { tag: tag.trim() } : {}) };
      return item ? api.patch(`/support/canned-replies/${item.id}`, payload) : api.post("/support/canned-replies", payload);
    },
    onSuccess: () => (toast(t("done")), void cache.invalidateQueries({ queryKey: CANNED_KEY }), onClose()),
  });
  // ใส่ตัวแปรตรงตำแหน่งเคอร์เซอร์
  const insert = (v: string) => {
    const [at, end] = sel.current ?? [body.length, body.length];
    setBody(body.slice(0, at) + v + body.slice(end));
    sel.current = [at + v.length, at + v.length];
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} className="dialog-wide" title={item ? t("dialogEdit") : t("dialogNew")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <div className="grid-2">
          <Input label={t("name")} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
          <Input label={t("tag")} value={tag} onChange={(e) => setTag(e.target.value)} maxLength={30} hint={t("tagHint")} />
        </div>
        <Textarea
          label={t("body")}
          rows={6}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onSelect={(e) => (sel.current = [e.currentTarget.selectionStart, e.currentTarget.selectionEnd])}
          maxLength={5000}
        />
        <div className="row">
          <span className="muted small">{t("vars")}</span>
          {VARIABLES.map((v) => (
            <Button key={v} size="small" aria-label={t("insert", { v })} onClick={() => insert(v)}>
              {v}
            </Button>
          ))}
        </div>
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!ok || m.isPending}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
