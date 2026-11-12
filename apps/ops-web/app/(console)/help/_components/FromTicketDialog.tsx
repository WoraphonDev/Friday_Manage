"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { ErrorBlock, Modal, Notice, TableSkeleton } from "@/components/kit";
import { Button, InlineError, Input, Select, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { type Article, type Category, HELP_KEY } from "./types";

interface Prefill {
  ticket: { id: string; number: number; subject: string; cause: string | null; status: string };
  draft: { title: string; body: string; categoryId: string | null };
}

/** X8 · สร้างบทความจาก Ticket ที่ปิดแล้ว (เปิดจากช่องติ๊กใน T5) · เป็นร่างเสมอ · เตือนข้อมูลส่วนบุคคล */
export function FromTicketDialog({ ticketId, categories, onClose }: { ticketId: string; categories: Category[]; onClose: () => void }) {
  const t = useTranslations("help.x8");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const router = useRouter();
  const cache = useQueryClient();
  const q = useQuery({ queryKey: [...HELP_KEY, "from-ticket", ticketId], queryFn: () => api.get<Prefill>(`/help/from-ticket/${ticketId}`) });
  const [title, setTitle] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [body, setBody] = useState("");
  const [link, setLink] = useState(true);
  useEffect(() => {
    if (!q.data) return;
    setTitle(q.data.draft.title);
    setBody(q.data.draft.body);
    setCategoryId(q.data.draft.categoryId ?? "");
  }, [q.data]);
  const m = useMutation({
    mutationFn: () => api.post<{ article: Article }>(`/help/from-ticket/${ticketId}`, { title: title.trim(), categoryId, body, link }),
    onSuccess: (r) => {
      toast({ message: t("done", { n: q.data?.ticket.number ?? "" }) });
      void cache.invalidateQueries({ queryKey: HELP_KEY });
      router.push(`/help/${r.article.id}`);
    },
  });
  const k = q.data?.ticket;
  const ok = title.trim().length >= 3 && !!categoryId;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("title", { n: k?.number ?? "…" })}
      description={k ? (k.cause ? t("sub", { subject: k.subject, cause: k.cause }) : t("subOpen", { subject: k.subject })) : undefined}
    >
      {q.isPending ? (
        <TableSkeleton rows={3} cols={1} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
          <Input label={`${t("name")} *`} value={title} onChange={(e) => setTitle(e.target.value)} />
          <Select label={`${t("category")} *`} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">{t("pick")}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Textarea label={t("body")} rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
          <Notice tone="warn">{t("warn")}</Notice>
          <label className="check">
            <input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} />
            <span>{t("link")}</span>
          </label>
          <InlineError error={m.error} />
          <div className="dialog-actions">
            <Button onClick={onClose}>{tc("cancel")}</Button>
            <Button type="submit" variant="primary" disabled={!ok || m.isPending}>
              {t("submit")}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
