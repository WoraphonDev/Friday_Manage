"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Lock, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button, Dialog, EmptyState, ErrorState, Input, LoadingState, Select, buttonVariants, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { RequestUpgradeButton } from "@/features/plan-limits";
import { checkoutHref, type Usage } from "@/features/plan-limits/types";
import { api, ApiError } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DiagramPreview } from "./preview";
import { TEMPLATES, type Diagram, type DiagramList, type Template } from "./types";
import styles from "./diagrams.module.css";

type Sort = "updated" | "name" | "created";

/** ไอคอนแบบเริ่มต้นในหน้าต่างสร้าง */
function TemplateIcon({ template }: { template: Template }) {
  const p = { className: styles.tplIcon, viewBox: "0 0 62 42", "aria-hidden": true as const };
  switch (template) {
    case "blank": return <svg {...p}><rect x="6" y="6" width="50" height="30" rx="4" strokeDasharray="4 3" /></svg>;
    case "flowchart": return <svg {...p}><rect x="18" y="2" width="26" height="9" rx="4.5" /><path d="M31 15l9 6-9 6-9-6z" /><rect x="18" y="31" width="26" height="9" rx="2" /></svg>;
    case "er": return <svg {...p}><rect x="3" y="5" width="22" height="32" rx="2" /><rect x="37" y="5" width="22" height="32" rx="2" /><path d="M25 20h12M3 12h22M37 12h22" /></svg>;
    case "architecture": return <svg {...p}><rect x="3" y="14" width="18" height="14" rx="2" /><ellipse cx="49" cy="21" rx="10" ry="12" /><path d="M21 21h18" /></svg>;
    case "whiteboard": return <svg {...p}><rect x="5" y="5" width="22" height="18" className={styles.tplNote} /><rect x="33" y="10" width="22" height="18" className={styles.tplNote} /><rect x="15" y="22" width="22" height="16" className={styles.tplNote} /></svg>;
  }
}

export function DiagramListPage({ ws, projectKey }: { ws: string; projectKey: string }) {
  const t = useTranslations("diagrams");
  const { me } = useWorkspace();
  const router = useRouter();
  const cache = useQueryClient();
  const toast = useToast();
  const base = `/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projectKey)}`;
  const pageHref = `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/diagrams`;
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [template, setTemplate] = useState<"" | Template>("");
  const [sort, setSort] = useState<Sort>("updated");
  const [trash, setTrash] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const h = setTimeout(() => setQ(qInput.trim()), 300);
    return () => clearTimeout(h);
  }, [qInput]);

  const params = new URLSearchParams({ sort });
  if (q) params.set("q", q);
  if (template) params.set("template", template);
  if (trash) params.set("trashed", "true");
  const list = useQuery({
    queryKey: ["diagrams", ws, projectKey, "list", params.toString()],
    // หน้านี้แสดงข้อความแพ็กเกจเอง ไม่เปิด Dialog 402 ทุกครั้งที่เข้าแท็บ
    queryFn: () => api.get<DiagramList>(`${base}/diagrams?${params}`, { planDialog: false }),
    retry: (count, e) => !(e instanceof ApiError && e.status < 500) && count < 2,
    // เห็นป้าย "กำลังแก้ไข" เปลี่ยนเองโดยไม่ต้องกดรีเฟรช
    refetchInterval: 30_000,
  });
  const planBlocked = list.error instanceof ApiError && list.error.code === "plan_feature_unavailable";
  const usage = useQuery({ queryKey: ["usage", ws], queryFn: () => api.get<Usage>(`/w/${encodeURIComponent(ws)}/usage`), enabled: planBlocked });

  if (planBlocked) {
    return (
      <div className={styles.page}>
        <div className={styles.upsell}>
          <h2 className={styles.h2}>{t("plan.title")}</h2>
          <p className={styles.muted}>{t("plan.description")}</p>
          <div className={styles.row}>
            {usage.data?.canManageBilling ? (
              <Link className={buttonVariants({ variant: "primary" })} href={checkoutHref(ws, "team_s")}>
                {t("plan.upgrade")}
              </Link>
            ) : (
              <RequestUpgradeButton />
            )}
          </div>
        </div>
      </div>
    );
  }
  if (list.error) return <div className={styles.page}><ErrorState error={list.error} retry={() => void list.refetch()} /></div>;

  const perms = list.data?.permissions;
  const items = list.data?.items ?? [];
  const filtered = !!(q || template);

  async function restore(id: string, name: string) {
    try {
      await api.post(`${base}/diagrams/${id}/restore`);
      toast({ message: t("trash.restored", { name }) });
      await cache.invalidateQueries({ queryKey: ["diagrams", ws, projectKey] });
    } catch (e) {
      toast({ message: e instanceof Error ? e.message : t("errors.unknown"), tone: "error" });
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div className={styles.row}>
          <Input className={styles.search} placeholder={t("list.search")} aria-label={t("list.search")} value={qInput} onChange={(e) => setQInput(e.target.value)} />
          <Select size="small" aria-label={t("list.type")} value={template} onChange={(e) => setTemplate(e.target.value as "" | Template)}>
            <option value="">{t("list.allTypes")}</option>
            {TEMPLATES.filter((x) => x !== "blank").map((x) => (
              <option key={x} value={x}>{t(`templates.${x}`)}</option>
            ))}
            <option value="blank">{t("templates.blank")}</option>
          </Select>
          {!trash && (
            <Select size="small" aria-label={t("list.sort")} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="updated">{t("list.sortUpdated")}</option>
              <option value="name">{t("list.sortName")}</option>
              <option value="created">{t("list.sortCreated")}</option>
            </Select>
          )}
        </div>
        <div className={styles.row}>
          {perms?.trash && (
            <Button size="small" variant={trash ? "primary" : "secondary"} aria-pressed={trash} onClick={() => setTrash((v) => !v)}>
              <Trash2 size={14} aria-hidden="true" /> {t("trash.toggle")}
            </Button>
          )}
          {perms?.edit && !trash && (
            <Button variant="primary" className={styles.desktopOnly} onClick={() => setCreating(true)}>
              <Plus size={16} aria-hidden="true" /> {t("list.create")}
            </Button>
          )}
        </div>
      </div>

      {list.isLoading ? (
        <LoadingState />
      ) : !items.length ? (
        <EmptyState
          title={trash ? t("trash.empty") : filtered ? t("list.noMatch") : t("list.emptyTitle")}
          description={trash || filtered ? undefined : perms?.edit ? t("list.emptyEdit") : t("list.emptyView")}
          action={!trash && !filtered && perms?.edit ? <Button variant="primary" className={styles.desktopOnly} onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> {t("list.create")}</Button> : undefined}
        />
      ) : (
        <div className={styles.grid}>
          {items.map((d) => {
            const by = d.updatedBy?.displayName ?? d.createdBy?.displayName ?? "";
            const body = (
              <>
                <div className={styles.thumb}>
                  <DiagramPreview preview={d.preview} />
                </div>
                <div className={styles.meta}>
                  <span className={styles.name}>{d.name}</span>
                  <span className={styles.chips}>
                    <span className={styles.typeChip}>{t(`templates.${d.template}`)}</span>
                    {d.issueCount > 0 && <span className={styles.typeChip}>{t("list.linked", { n: d.issueCount })}</span>}
                    {d.lock && !trash && (
                      <span className={styles.lockChip}>
                        <Lock size={11} aria-hidden="true" />
                        {d.lock.userId === me.id ? t("list.editingYou") : t("list.editing", { name: d.lock.user?.displayName ?? "" })}
                      </span>
                    )}
                  </span>
                  <span className={styles.sub}>
                    {trash
                      ? t("trash.deletedBy", { name: d.deletedBy?.displayName ?? "", date: formatDate(d.deletedAt, me.yearFormat) })
                      : t("list.updatedBy", { name: by, date: formatDate(d.updatedAt, me.yearFormat) })}
                  </span>
                </div>
              </>
            );
            return trash ? (
              <div key={d.id} className={cn(styles.card, styles.cardTrash)}>
                {body}
                <div className={styles.cardActions}>
                  <Button size="small" onClick={() => void restore(d.id, d.name)}>
                    <RotateCcw size={14} aria-hidden="true" /> {t("trash.restore")}
                  </Button>
                </div>
              </div>
            ) : (
              <Link key={d.id} href={`${pageHref}/${d.id}`} className={styles.card}>
                {body}
              </Link>
            );
          })}
        </div>
      )}

      <CreateDialog
        open={creating}
        onOpenChange={setCreating}
        onCreate={async (input) => {
          const d = await api.post<Diagram>(`${base}/diagrams`, input);
          cache.setQueryData(["diagrams", ws, projectKey, "detail", d.id], d);
          await cache.invalidateQueries({ queryKey: ["diagrams", ws, projectKey, "list"] });
          router.push(`${pageHref}/${d.id}`);
        }}
      />
    </div>
  );
}

function CreateDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (v: boolean) => void; onCreate: (input: { name: string; description: string | null; template: Template }) => Promise<void> }) {
  const t = useTranslations("diagrams");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState<Template>("blank");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setTemplate("blank");
      setError("");
    }
  }, [open]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError(t("create.nameRequired"));
      return;
    }
    setPending(true);
    setError("");
    try {
      await onCreate({ name: name.trim(), description: description.trim() || null, template });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.unknown"));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("create.title")} size="medium">
      <form className={styles.form} onSubmit={submit}>
        <Input id="diagram-name" label={t("create.name")} value={name} maxLength={120} autoFocus onChange={(e) => setName(e.target.value)} error={error && !name.trim() ? error : undefined} />
        <Input id="diagram-description" label={t("create.description")} hint={t("create.optional")} placeholder={t("create.descriptionPlaceholder")} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
        <fieldset className={styles.tplField}>
          <legend>{t("create.template")}</legend>
          <div className={styles.tpls}>
            {TEMPLATES.map((x) => (
              <button key={x} type="button" className={cn(styles.tpl, template === x && styles.tplOn)} aria-pressed={template === x} onClick={() => setTemplate(x)}>
                <TemplateIcon template={x} />
                {t(`templates.${x}`)}
              </button>
            ))}
          </div>
          <p className={styles.hint}>{t("create.templateHint")}</p>
        </fieldset>
        {error && name.trim() && <p className={styles.err} role="alert">{error}</p>}
        <div className={styles.formActions}>
          <Button onClick={() => onOpenChange(false)}>{t("create.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={pending}>{t("create.submit")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
