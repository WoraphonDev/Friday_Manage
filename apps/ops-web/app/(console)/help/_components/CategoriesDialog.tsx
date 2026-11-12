"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Modal } from "@/components/kit";
import { Button, InlineError, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import styles from "../help.module.css";
import { type Category, HELP_KEY } from "./types";

interface Row {
  key: string;
  id?: string;
  slug?: string;
  name: string;
  nameEn: string | null;
  articles: number;
}

/** X9 · จัดการหมวด: เรียงลำดับ (ลาก หรือปุ่มขึ้น / ลงสำหรับคีย์บอร์ด) · แก้ชื่อ · เพิ่ม · ลบเมื่อไม่มีบทความ · บันทึกครั้งเดียว */
export function CategoriesDialog({ categories, onClose }: { categories: Category[]; onClose: () => void }) {
  const t = useTranslations("help.x9");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [rows, setRows] = useState<Row[]>(() =>
    [...categories].sort((a, b) => a.position - b.position).map((c) => ({ key: c.id, id: c.id, slug: c.slug, name: c.name, nameEn: c.nameEn, articles: c.articles })),
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [n, setN] = useState(0);
  const valid = rows.every((r) => r.name.trim().length > 0);

  const move = (from: number, to: number) =>
    setRows((list) => {
      if (to < 0 || to >= list.length || from === to) return list;
      const next = [...list];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item!);
      return next;
    });
  const rename = (key: string, name: string) => setRows((list) => list.map((r) => (r.key === key ? { ...r, name } : r)));

  const m = useMutation({
    mutationFn: () =>
      api.put<{ items: Category[] }>("/help/categories", {
        items: rows.map((r) => ({ ...(r.id ? { id: r.id } : {}), name: r.name.trim(), ...(r.nameEn ? { nameEn: r.nameEn } : {}), ...(r.slug ? { slug: r.slug } : {}) })),
      }),
    onSuccess: () => {
      toast({ message: t("saved") });
      void cache.invalidateQueries({ queryKey: HELP_KEY });
      onClose();
    },
  });

  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title")} description={t("desc")}>
      <div className="dialog-body">
        <ul className={styles.catList}>
          {rows.map((r, i) => (
            <li
              key={r.key}
              draggable
              data-dragging={dragging === i}
              onDragStart={() => setDragging(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => (dragging !== null && move(dragging, i), setDragging(null))}
              onDragEnd={() => setDragging(null)}
            >
              <GripVertical size={16} className={styles.grip} aria-hidden="true" />
              {editing === r.key ? (
                <input className="input" aria-label={t("renameLabel", { name: r.name })} value={r.name} autoFocus onChange={(e) => rename(r.key, e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), setEditing(null))} />
              ) : (
                <span className={styles.name}>{r.name}</span>
              )}
              <span className={styles.count}>{t("articles", { n: r.articles })}</span>
              <Button size="icon" variant="ghost" aria-label={t("up", { name: r.name })} disabled={i === 0} onClick={() => move(i, i - 1)}>
                <ArrowUp size={14} />
              </Button>
              <Button size="icon" variant="ghost" aria-label={t("down", { name: r.name })} disabled={i === rows.length - 1} onClick={() => move(i, i + 1)}>
                <ArrowDown size={14} />
              </Button>
              <button type="button" className="link-button" onClick={() => setEditing(editing === r.key ? null : r.key)}>
                {editing === r.key ? t("done") : t("rename")}
              </button>
              {r.articles === 0 && (
                <button type="button" className="link-button text-danger" aria-label={t("removeLabel", { name: r.name })} onClick={() => setRows((list) => list.filter((x) => x.key !== r.key))}>
                  {t("remove")}
                </button>
              )}
            </li>
          ))}
        </ul>
        <div>
          <Button
            size="small"
            onClick={() => {
              const key = `new-${n}`;
              setN(n + 1);
              setRows((list) => [...list, { key, name: t("newName"), nameEn: null, articles: 0 }]);
              setEditing(key);
            }}
          >
            {t("add")}
          </Button>
        </div>
        <p className="muted small">{t("note")}</p>
        {!valid && <p className="field-error">{t("emptyName")}</p>}
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button variant="primary" disabled={!valid || m.isPending} onClick={() => m.mutate()}>
            {t("save")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
