"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bookmark, MoreHorizontal, Pin, Star, Users } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { defer, UNDO_MS } from "@/lib/outbox";
import { currentFilters, sameFilters, type SavedView, useViews, type ViewPage, VIEWS_KEY } from "@/lib/views";
import { Chip, Modal, Popover } from "./kit";
import { Button, errorToast, InlineError, Input, useToast } from "./ui";

const ROLES = ["owner", "finance", "support", "engineer", "auditor"] as const;

/**
 * แถบมุมมองเหนือรายการ (ช่วง 3) · กดชื่อ = ใส่ตัวกรองชุดนั้น · ⋯ = ปัก / ค่าเริ่มต้น / คัดลอก / ซ่อน / ลบ
 * เปิดจากเมนูซ้าย (?view=) หรือมุมมองเริ่มต้นของหน้า (เข้าหน้าโดยไม่มีตัวกรอง) ใส่ให้เองครั้งเดียว
 */
export function ViewsBar({ page, values, defaults, onApply }: { page: ViewPage; values: Record<string, string>; defaults: Record<string, string>; onApply: (filters: Record<string, string>) => void }) {
  const t = useTranslations("common.views");
  const views = useViews(page);
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const cache = useQueryClient();
  const [removing, setRemoving] = useState<string[]>([]);
  const [dialog, setDialog] = useState<{ mode: "save" } | { mode: "rename"; view: SavedView } | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const started = useRef(false);
  const current = currentFilters(values, defaults);
  const all = (views.data?.items ?? []).filter((v) => !removing.includes(v.id));
  const shown = all.filter((v) => !v.hidden);
  const hidden = all.filter((v) => v.hidden);
  const active = shown.find((v) => sameFilters(v.filters, current)) ?? null;
  const baseView = all.find((v) => v.id === base) ?? null;
  const apply = (v: SavedView | null) => {
    setBase(v?.id ?? null);
    onApply(v?.filters ?? {});
  };
  const asked = params?.get("view") ?? null;
  // เปิดจากลิงก์ / เมนูซ้าย หรือมุมมองเริ่มต้น
  useEffect(() => {
    if (!views.data) return;
    if (asked) {
      const v = views.data.items.find((x) => x.id === asked);
      if (v) apply(v);
      else {
        // มุมมองถูกลบหรือไม่มีสิทธิ์เห็นแล้ว: เอา ?view= ออกแล้วบอก
        const next = new URLSearchParams(params?.toString() ?? "");
        next.delete("view");
        const s = next.toString();
        router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
        toast({ message: t("gone"), tone: "error" });
      }
      started.current = true;
      return;
    }
    if (started.current) return;
    started.current = true;
    const def = views.data.items.find((v) => v.isDefault && !v.hidden);
    if (def && !Object.keys(current).length) apply(def);
    // ใช้ค่าตอนข้อมูลมุมมองมาถึง / ?view= เปลี่ยนเท่านั้น
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views.data, asked]);

  const refresh = () => cache.invalidateQueries({ queryKey: VIEWS_KEY });
  const prefs = useMutation({
    mutationFn: ({ v, body }: { v: SavedView; body: Partial<Pick<SavedView, "pinned" | "hidden" | "isDefault">> }) => api.put<SavedView>(`/views/${v.id}/prefs`, body),
    onSuccess: (_, { v, body }) => {
      void refresh();
      if (body.pinned != null) toast(t(body.pinned ? "pinned" : "unpinned", { name: v.name }));
      if (body.isDefault) toast(t("defaultSet", { name: v.name }));
      if (body.hidden) toast({ message: t("hiddenDone", { name: v.name }), undo: () => prefs.mutate({ v, body: { hidden: false } }) });
    },
    onError: (e) => toast(errorToast(e)),
  });
  const copy = useMutation({
    mutationFn: (v: SavedView) => api.post<SavedView>(`/views/${v.id}/copy`, {}),
    onSuccess: (v) => (void refresh(), setBase(v.id), toast(t("copied", { name: v.name }))),
    onError: (e) => toast(errorToast(e)),
  });
  // ลบแบบย้อนกลับได้ 10 วินาที (ไม่ใช่ข้อความถึงลูกค้า)
  const remove = (v: SavedView) => {
    setRemoving((r) => [...r, v.id]);
    if (base === v.id) setBase(null);
    const job = defer(
      `view:${v.id}`,
      () => api.delete(`/views/${v.id}`).then(refresh),
      (e) => (setRemoving((r) => r.filter((x) => x !== v.id)), toast(errorToast(e))),
    );
    toast({ message: t("deleted", { name: v.name }), duration: UNDO_MS, undo: () => job.cancel() && setRemoving((r) => r.filter((x) => x !== v.id)) });
  };
  const dirty = Object.keys(current).length > 0 && !active;
  return (
    <div className="views-bar" role="toolbar" aria-label={t("label")}>
      <Bookmark size={14} className="muted" aria-hidden="true" />
      <Chip pressed={!active && !Object.keys(current).length} onClick={() => apply(null)}>
        {t("all")}
      </Chip>
      {shown.map((v) => (
        <span key={v.id} className="view-chip">
          <Chip pressed={active?.id === v.id} onClick={() => apply(v)}>
            {v.team && <Users size={12} aria-label={t("teamTag")} />}
            {v.name}
            {v.isDefault && <Star size={11} aria-label={t("defaultTag")} />}
            {v.pinned && <Pin size={11} aria-label={t("pinnedTag")} />}
          </Chip>
          <Popover
            label={t("menu", { name: v.name })}
            trigger={({ toggle, open }) => (
              <button type="button" className="icon-button view-more" aria-label={t("menu", { name: v.name })} aria-expanded={open} onClick={toggle}>
                <MoreHorizontal size={14} />
              </button>
            )}
          >
            {(close) => (
              <div className="stack" style={{ gap: 2 }}>
                {[
                  { label: t(v.pinned ? "unpin" : "pin"), run: () => prefs.mutate({ v, body: { pinned: !v.pinned } }) },
                  { label: t(v.isDefault ? "undefault" : "makeDefault"), run: () => prefs.mutate({ v, body: { isDefault: !v.isDefault } }) },
                  { label: t("copy"), run: () => copy.mutate(v) },
                  ...(v.canEdit ? [{ label: t("rename"), run: () => setDialog({ mode: "rename", view: v }) }] : []),
                  ...(v.team ? [{ label: t("hide"), run: () => prefs.mutate({ v, body: { hidden: true } }) }] : []),
                  ...(v.canEdit ? [{ label: t("delete"), run: () => remove(v), danger: true }] : []),
                ].map((a) => (
                  <button key={a.label} type="button" className={a.danger ? "menu-item danger" : "menu-item"} onClick={() => (close(), a.run())}>
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </Popover>
        </span>
      ))}
      {hidden.length > 0 && (
        <Popover
          label={t("hiddenTitle")}
          trigger={({ toggle, open }) => (
            <button type="button" className="link-button small" aria-expanded={open} onClick={toggle}>
              {t("hiddenCount", { n: hidden.length })}
            </button>
          )}
        >
          {(close) => (
            <div className="stack" style={{ gap: 2 }}>
              {hidden.map((v) => (
                <button key={v.id} type="button" className="menu-item" onClick={() => (close(), prefs.mutate({ v, body: { hidden: false } }))}>
                  {t("unhide", { name: v.name })}
                </button>
              ))}
            </div>
          )}
        </Popover>
      )}
      {dirty && (
        <Button size="small" onClick={() => setDialog({ mode: "save" })}>
          {t("save")}
        </Button>
      )}
      {dialog && (
        <SaveDialog
          page={page}
          filters={current}
          base={dialog.mode === "rename" ? dialog.view : baseView?.canEdit ? baseView : null}
          rename={dialog.mode === "rename"}
          canManageTeam={!!views.data?.canManageTeam}
          onClose={() => setDialog(null)}
          onSaved={(v) => (setDialog(null), setBase(v.id), void refresh())}
        />
      )}
    </div>
  );
}

/** บันทึกมุมมอง: บันทึกทับมุมมองเดิม (ที่แก้ได้) หรือบันทึกเป็นมุมมองใหม่ · ของทีมเฉพาะ Owner / หัวหน้าทีม */
function SaveDialog({ page, filters, base, rename, canManageTeam, onClose, onSaved }: { page: ViewPage; filters: Record<string, string>; base: SavedView | null; rename: boolean; canManageTeam: boolean; onClose: () => void; onSaved: (v: SavedView) => void }) {
  const t = useTranslations("common.views");
  const tr = useTranslations("common.roles");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const [mode, setMode] = useState<"overwrite" | "new">(base && !rename ? "overwrite" : "new");
  const [name, setName] = useState(rename && base ? base.name : "");
  const [team, setTeam] = useState(false);
  const [roles, setRoles] = useState<string[]>([]);
  const m = useMutation({
    mutationFn: () =>
      rename && base
        ? api.patch<SavedView>(`/views/${base.id}`, { name: name.trim() })
        : mode === "overwrite" && base
          ? api.patch<SavedView>(`/views/${base.id}`, { filters })
          : api.post<SavedView>("/views", { page, name: name.trim(), filters, roles: team ? roles : [] }),
    onSuccess: (v) => (toast(t(rename ? "renamed" : "saved", { name: v.name })), onSaved(v)),
  });
  const needName = rename || mode === "new";
  const ok = (!needName || name.trim().length > 0) && (!team || roles.length > 0);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={rename ? t("renameTitle") : t("saveTitle")} description={rename ? undefined : t("saveDesc", { n: Object.keys(filters).length })}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        {base && !rename && (
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">{t("how")}</legend>
            <label className="check">
              <input type="radio" name="view-mode" checked={mode === "overwrite"} onChange={() => setMode("overwrite")} />
              <span>{t("overwrite", { name: base.name })}</span>
            </label>
            <label className="check">
              <input type="radio" name="view-mode" checked={mode === "new"} onChange={() => setMode("new")} />
              <span>{t("asNew")}</span>
            </label>
          </fieldset>
        )}
        {needName && <Input label={t("name")} value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} />}
        {!rename && mode === "new" && canManageTeam && (
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">{t("who")}</legend>
            <label className="check">
              <input type="radio" name="view-who" checked={!team} onChange={() => setTeam(false)} />
              <span>{t("personal")}</span>
            </label>
            <label className="check">
              <input type="radio" name="view-who" checked={team} onChange={() => setTeam(true)} />
              <span>{t("team")}</span>
            </label>
            {team && (
              <div className="row" role="group" aria-label={t("teamRoles")}>
                {ROLES.map((r) => (
                  <label key={r} className="check">
                    <input type="checkbox" checked={roles.includes(r)} onChange={() => setRoles(roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r])} />
                    <span>{tr(r)}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        )}
        {!rename && mode === "new" && !canManageTeam && <p className="muted small">{t("teamHint")}</p>}
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!ok || m.isPending}>
            {rename ? t("renameDo") : mode === "overwrite" && base ? t("overwriteDo") : t("saveDo")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
