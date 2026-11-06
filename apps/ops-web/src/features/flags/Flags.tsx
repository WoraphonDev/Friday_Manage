"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button, Dialog, EmptyState, ErrorState, InlineError, Input, LoadingState, Pill, Select, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { keys } from "@/lib/query";
import type { Flag, WorkspaceRow } from "@/lib/types";
import { PageHeader } from "../shell/Shell";
import { Announcements } from "./Announcements";

export function FlagsPage() {
  const t = useTranslations("ops");
  return (
    <>
      <PageHeader title={t("titles.flags")} desc={t("titles.flagsDesc")} />
      <Flags />
      <Announcements />
    </>
  );
}

function Flags() {
  const t = useTranslations("ops.flags");
  const q = useQuery({ queryKey: keys.flags, queryFn: () => api.get<{ items: Flag[] }>("/feature-flags") });
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const flag = q.data?.items.find((f) => f.id === editing);
  return (
    <section className="card">
      <div className="ch">
        <div>
          <h2>{t("title")}</h2>
          <span className="muted small-13">{t("desc")}</span>
        </div>
        <Button onClick={() => setEditing("new")}>{t("create")}</Button>
      </div>
      {q.isPending ? (
        <LoadingState />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => void q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <EmptyState title={t("empty")} description={t("emptyDesc")} />
      ) : (
        q.data.items.map((f) => {
          const on = f.overrides.filter((o) => o.enabled).length;
          return (
            <div className="pr" key={f.id}>
              <div className="grow-260">
                <b className="mono">{f.key}</b>
                <div className="muted small">{f.description}</div>
              </div>
              <Pill tone={f.defaultOn ? "ok" : on ? "inf" : "neu"}>{f.defaultOn ? t("everyone") : on ? t("some", { count: on }) : t("off")}</Pill>
              <Button aria-label={`${t("edit")} ${f.key}`} onClick={() => setEditing(f.id)}>
                {t("edit")}
              </Button>
            </div>
          );
        })
      )}
      {editing === "new" && <FlagDialog onClose={() => setEditing(null)} />}
      {flag && <FlagDialog flag={flag} onClose={() => setEditing(null)} />}
    </section>
  );
}

function FlagDialog({ flag, onClose }: { flag?: Flag; onClose: () => void }) {
  const t = useTranslations("ops");
  const toast = useToast();
  const cache = useQueryClient();
  const [key, setKey] = useState(flag?.key ?? "");
  const [description, setDescription] = useState(flag?.description ?? "");
  const [defaultOn, setDefaultOn] = useState(flag?.defaultOn ?? false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refresh = () => cache.invalidateQueries({ queryKey: keys.flags });
  const save = useMutation({
    mutationFn: () => {
      const body = { key: key.trim(), description: description.trim() || null, defaultOn };
      return flag ? api.patch(`/feature-flags/${flag.id}`, body) : api.post("/feature-flags", body);
    },
    onSuccess: () => {
      toast(flag ? t("flags.saved") : t("flags.created"));
      void refresh();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/feature-flags/${flag!.id}`),
    onSuccess: () => {
      toast(t("flags.deleted"));
      void refresh();
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={flag ? `${t("flags.edit")} ${flag.key}` : t("flags.create")}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Input label={t("flags.key")} className="mono" value={key} onChange={(e) => setKey(e.target.value)} hint={t("flags.keyHint")} />
        <Input label={t("flags.description")} value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={defaultOn} onChange={(e) => setDefaultOn(e.target.checked)} />
          {t("flags.defaultOn")}
        </label>
        <InlineError error={save.error ?? remove.error} />
        <div className="dialog-actions">
          {flag && (
            <Button variant={confirmDelete ? "danger" : "ghost"} className="mr-auto" disabled={remove.isPending} onClick={() => (confirmDelete ? remove.mutate() : setConfirmDelete(true))}>
              {confirmDelete ? t("flags.confirmDelete") : t("flags.delete")}
            </Button>
          )}
          <Button onClick={onClose}>{t("ui.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={save.isPending || !key.trim()}>
            {save.isPending ? t("ui.saving") : t("ui.save")}
          </Button>
        </div>
      </form>
      {flag && <Overrides flag={flag} />}
    </Dialog>
  );
}

/** override ต่อ Workspace (PUT / DELETE) · ops-api เขียน Audit Log ของ Workspace นั้น */
function Overrides({ flag }: { flag: Flag }) {
  const t = useTranslations("ops");
  const toast = useToast();
  const cache = useQueryClient();
  const [ws, setWs] = useState("");
  const [enabled, setEnabled] = useState("true");
  const workspaces = useQuery({ queryKey: keys.workspaces({ limit: "200" }), queryFn: () => api.get<{ items: WorkspaceRow[] }>("/workspaces?limit=200") });
  const done = () => {
    toast(t("flags.overrideSaved"));
    void cache.invalidateQueries({ queryKey: keys.flags });
  };
  const put = useMutation({ mutationFn: () => api.put(`/feature-flags/${flag.id}/overrides/${ws}`, { enabled: enabled === "true" }), onSuccess: done });
  const del = useMutation({ mutationFn: (workspaceId: string) => api.delete(`/feature-flags/${flag.id}/overrides/${workspaceId}`), onSuccess: done });
  return (
    <div className="stack-10 overrides">
      <b className="small-13">{t("flags.overrides")}</b>
      {flag.overrides.length === 0 ? (
        <span className="muted small-13">{t("flags.noOverrides")}</span>
      ) : (
        flag.overrides.map((o) => (
          <div className="kv" key={o.workspaceId}>
            <span>
              {o.name} <span className="muted mono">{o.slug}</span>
            </span>
            <span className="row-6">
              <Pill tone={o.enabled ? "ok" : "neu"}>{o.enabled ? t("flags.on") : t("flags.offShort")}</Pill>
              <Button size="small" aria-label={`${t("flags.remove")} ${o.name}`} disabled={del.isPending} onClick={() => del.mutate(o.workspaceId)}>
                {t("flags.remove")}
              </Button>
            </span>
          </div>
        ))
      )}
      <div className="override-add">
        <Select label={t("flags.workspace")} value={ws} onChange={(e) => setWs(e.target.value)}>
          <option value="">{t("flags.pickWorkspace")}</option>
          {workspaces.data?.items.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} ({w.slug})
            </option>
          ))}
        </Select>
        <Select label={t("flags.value")} value={enabled} onChange={(e) => setEnabled(e.target.value)}>
          <option value="true">{t("flags.on")}</option>
          <option value="false">{t("flags.offShort")}</option>
        </Select>
        <Button disabled={!ws || put.isPending} onClick={() => put.mutate()}>
          {t("flags.addOverride")}
        </Button>
      </div>
      <InlineError error={put.error ?? del.error ?? workspaces.error} />
    </div>
  );
}
