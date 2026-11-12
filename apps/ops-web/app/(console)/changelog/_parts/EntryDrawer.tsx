"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Drawer, Modal, Notice, Seg } from "@/components/kit";
import { Button, InlineError, Input, Select, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { keys } from "@/lib/query";
import type { Flag } from "@/lib/types";
import { planLabel } from "../../workspaces/_parts/format";
import styles from "../changelog.module.css";
import { PanelPreview } from "./labels";
import { type Audience, CHANGELOG_KEY, CTA_PRESETS, type Entry, type Kind, PLAN_CODES } from "./types";

type Action = "draft" | "publish" | "schedule";
const CUSTOM = "__custom";

/** ค่าเวลาในช่อง datetime-local (เวลาเครื่อง) ↔ ISO */
const toLocal = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * U4 · เขียน / แก้รายการ Changelog (Drawer ด้านขวา)
 * รายการที่เผยแพร่แล้วแก้เนื้อหาได้อย่างเดียว (ถอนใช้ U7) · Spotlight ทีละรายการ: เผยแพร่รายการนี้แล้วรายการเดิมถูกปลด
 */
export function EntryDrawer({ entry, entries, canWrite, onClose }: { entry: Entry | null; entries: Entry[]; canWrite: boolean; onClose: () => void }) {
  const t = useTranslations("cl.editor");
  const tk = useTranslations("cl.kind");
  const toast = useToast();
  const cache = useQueryClient();
  const live = entry?.status === "published";
  const [f, setF] = useState(() => ({
    title: entry?.title ?? "",
    kind: (entry?.kind ?? "new") as Kind,
    displayDate: entry?.displayDate ?? "",
    summary: entry?.summary ?? "",
    body: entry?.body ?? "",
    mediaUrl: entry?.mediaUrl ?? "",
    mediaKind: (entry?.mediaKind ?? "image") as "image" | "video",
    mediaAlt: entry?.mediaAlt ?? "",
    ctaLabel: entry?.ctaLabel ?? "",
    ctaPath: entry?.ctaPath ?? "",
    audience: (entry?.audience ?? "all") as Audience,
    audiencePlans: entry?.audiencePlans ?? [],
    audienceFlag: entry?.audienceFlag ?? "",
    spotlight: entry?.spotlight ?? false,
    showPublic: entry?.showPublic ?? true,
    when: (entry?.status === "scheduled" ? "schedule" : "publish") as "publish" | "schedule",
    publishAt: entry?.status === "scheduled" ? toLocal(entry.publishedAt) : "",
    titleEn: entry?.titleEn ?? "",
    summaryEn: entry?.summaryEn ?? "",
    bodyEn: entry?.bodyEn ?? "",
    ctaLabelEn: entry?.ctaLabelEn ?? "",
  }));
  const [english, setEnglish] = useState(!!entry?.titleEn);
  const [previewing, setPreviewing] = useState(false);
  const [touched, setTouched] = useState(false);
  const [customPath, setCustomPath] = useState(!!f.ctaPath && !CTA_PRESETS.some((p) => p.path === f.ctaPath));
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const flags = useQuery({ queryKey: keys.flags, queryFn: () => api.get<{ items: Flag[] }>("/feature-flags"), enabled: f.audience === "flag" });
  const spotlightOwner = entries.find((x) => x.spotlight && x.id !== entry?.id && (x.status === "published" || x.status === "scheduled"));
  const required = f.title.trim().length > 0 && f.summary.trim().length > 0 && f.summary.length <= 140;

  const save = useMutation({
    mutationFn: (action: Action) => {
      const body = {
        kind: f.kind,
        title: f.title,
        summary: f.summary,
        body: f.body,
        titleEn: english ? f.titleEn : null,
        summaryEn: english ? f.summaryEn : null,
        bodyEn: english ? f.bodyEn : null,
        mediaUrl: f.mediaUrl || null,
        mediaKind: f.mediaUrl ? f.mediaKind : null,
        mediaAlt: f.mediaUrl ? f.mediaAlt : null,
        ctaLabel: f.ctaPath ? f.ctaLabel : null,
        ctaLabelEn: f.ctaPath && english ? f.ctaLabelEn : null,
        ctaPath: f.ctaPath || null,
        audience: f.audience,
        audiencePlans: f.audience === "plans" ? f.audiencePlans : [],
        audienceFlag: f.audience === "flag" ? f.audienceFlag || null : null,
        spotlight: f.spotlight,
        showPublic: f.showPublic,
        displayDate: f.displayDate || null,
        action,
        publishAt: action === "schedule" && f.publishAt ? new Date(f.publishAt).toISOString() : null,
      };
      return entry ? api.put<{ item: Entry; spotlightMovedFrom: string | null }>(`/changelog/${entry.id}`, body) : api.post<{ item: Entry; spotlightMovedFrom: string | null }>("/changelog", body);
    },
    onSuccess: (r) => {
      toast(r.spotlightMovedFrom ? t("moved", { title: r.spotlightMovedFrom }) : t("created", { title: r.item.title }));
      void cache.invalidateQueries({ queryKey: CHANGELOG_KEY });
      onClose();
    },
  });
  const submit = (action: Action) => {
    setTouched(true);
    if (!required) return;
    save.mutate(action);
  };
  const issues = (save.error as { details?: { issues?: { path: string; message: string }[] } } | null)?.details?.issues ?? [];
  const fieldError = (k: string) => issues.find((i) => i.path === k)?.message;

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={entry ? t("editTitle") : t("createTitle")} description={t("desc")} wide>
      <form
        className={clsx("dialog-body", styles.form)}
        onSubmit={(e) => {
          e.preventDefault();
          submit(live ? "publish" : f.when);
        }}
      >
        <fieldset className={styles.fieldset} disabled={!canWrite}>
          <Input label={`${t("titleLabel")} *`} value={f.title} maxLength={120} onChange={(e) => set("title", e.target.value)} error={touched && !f.title.trim() ? t("required") : fieldError("title")} />
          <div className="grid-2">
            <div className="field">
              <span className="field-label">{t("kind")}</span>
              <Seg label={t("kind")} value={f.kind} onChange={(v) => set("kind", v)} options={(["new", "improved", "fixed"] as const).map((v) => ({ value: v, label: tk(v) }))} />
            </div>
            <Input label={t("displayDate")} type="date" value={f.displayDate} onChange={(e) => set("displayDate", e.target.value)} hint={t("displayDateHint")} />
          </div>
          <Textarea
            label={`${t("summary")} *`}
            rows={2}
            value={f.summary}
            onChange={(e) => set("summary", e.target.value)}
            hint={t("summaryHint", { n: f.summary.length })}
            error={touched && (!f.summary.trim() || f.summary.length > 140) ? t("summaryHint", { n: f.summary.length }) : fieldError("summary")}
          />
          <Textarea label={t("body")} rows={5} value={f.body} onChange={(e) => set("body", e.target.value)} hint={t("bodyHint")} />
          <div className="grid-2">
            <Input label={t("media")} type="url" placeholder="https://" value={f.mediaUrl} onChange={(e) => set("mediaUrl", e.target.value)} hint={t("mediaHint")} error={fieldError("mediaUrl")} />
            <Select label={t("mediaKind")} value={f.mediaKind} disabled={!f.mediaUrl} onChange={(e) => set("mediaKind", e.target.value as "image" | "video")}>
              <option value="image">{t("mediaImage")}</option>
              <option value="video">{t("mediaVideo")}</option>
            </Select>
          </div>
          {f.mediaUrl && <Input label={t("mediaAlt")} value={f.mediaAlt} maxLength={200} onChange={(e) => set("mediaAlt", e.target.value)} error={fieldError("mediaAlt")} />}
          <div className="grid-2">
            <Select
              label={t("ctaPath")}
              value={customPath ? CUSTOM : f.ctaPath}
              onChange={(e) => {
                const v = e.target.value;
                setCustomPath(v === CUSTOM);
                if (v !== CUSTOM) set("ctaPath", v);
              }}
            >
              <option value="">{t("ctaNone")}</option>
              {CTA_PRESETS.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.label}
                </option>
              ))}
              <option value={CUSTOM}>{t("ctaCustom")}</option>
            </Select>
            <Input label={t("ctaLabel")} value={f.ctaLabel} maxLength={40} disabled={!f.ctaPath && !customPath} onChange={(e) => set("ctaLabel", e.target.value)} error={fieldError("ctaLabel")} />
          </div>
          {customPath && <Input label={t("ctaPath")} value={f.ctaPath} placeholder="/profile?tab=notify" onChange={(e) => set("ctaPath", e.target.value)} hint={t("ctaPathHint")} error={fieldError("ctaPath")} />}

          <h3 className={styles.h}>{t("audience")}</h3>
          <div className={styles.opts} role="radiogroup" aria-label={t("audience")}>
            {(["all", "plans", "flag", "admins"] as const).map((a) => (
              <label key={a} className={f.audience === a ? "opt opt-on" : "opt"}>
                <input type="radio" name="cl-audience" checked={f.audience === a} onChange={() => set("audience", a)} />
                <span>
                  <b>{t(`aud.${a}`)}</b>
                  <span className="cell-sub">{t(`aud.${a}Desc`)}</span>
                </span>
              </label>
            ))}
          </div>
          {f.audience === "plans" && (
            <fieldset className={styles.checks}>
              <legend className="field-label">{t("plans")}</legend>
              {PLAN_CODES.map((p) => (
                <label key={p} className="check">
                  <input type="checkbox" checked={f.audiencePlans.includes(p)} onChange={(e) => set("audiencePlans", e.target.checked ? [...f.audiencePlans, p] : f.audiencePlans.filter((x) => x !== p))} />
                  <span>{planLabel(p)}</span>
                </label>
              ))}
              {fieldError("audiencePlans") && <span className="field-error">{fieldError("audiencePlans")}</span>}
            </fieldset>
          )}
          {f.audience === "flag" &&
            (flags.data && !flags.data.items.length ? (
              <p className="muted small">{t("flagNone")}</p>
            ) : (
              <Select label={t("flag")} value={f.audienceFlag} onChange={(e) => set("audienceFlag", e.target.value)} error={fieldError("audienceFlag")}>
                <option value="">{t("flagPick")}</option>
                {flags.data?.items.map((fl) => (
                  <option key={fl.id} value={fl.key}>
                    {fl.key}
                  </option>
                ))}
              </Select>
            ))}
          <label className="check">
            <input type="checkbox" checked={f.spotlight} onChange={(e) => set("spotlight", e.target.checked)} />
            <span>{t("spotlight")}</span>
          </label>
          {f.spotlight && spotlightOwner && <Notice tone="warn">{t("spotlightTaken", { title: spotlightOwner.title })}</Notice>}
          <label className="check">
            <input type="checkbox" checked={f.showPublic} onChange={(e) => set("showPublic", e.target.checked)} />
            <span>{t("showPublic")}</span>
          </label>

          {live ? (
            <p className="muted small">{t("liveNote")}</p>
          ) : (
            <div className="grid-2">
              <div className="field">
                <span className="field-label">{t("publish")}</span>
                <Seg label={t("publish")} value={f.when} onChange={(v) => set("when", v)} options={[{ value: "publish" as const, label: t("now") }, { value: "schedule" as const, label: t("schedule") }]} />
              </div>
              {f.when === "schedule" && <Input label={t("publishAt")} type="datetime-local" value={f.publishAt} onChange={(e) => set("publishAt", e.target.value)} error={fieldError("publishAt")} />}
            </div>
          )}

          {english ? (
            <section className={styles.english} aria-label={t("english")}>
              <Input label={t("titleEn")} value={f.titleEn} maxLength={120} onChange={(e) => set("titleEn", e.target.value)} />
              <Textarea label={t("summaryEn")} rows={2} value={f.summaryEn} maxLength={140} onChange={(e) => set("summaryEn", e.target.value)} />
              <Textarea label={t("bodyEn")} rows={3} value={f.bodyEn} onChange={(e) => set("bodyEn", e.target.value)} />
              {f.ctaPath && <Input label={t("ctaLabelEn")} value={f.ctaLabelEn} maxLength={40} onChange={(e) => set("ctaLabelEn", e.target.value)} />}
            </section>
          ) : (
            <Notice tone="info" action={canWrite ? <Button size="small" onClick={() => setEnglish(true)}>{t("englishShow")}</Button> : undefined}>
              {t("englishMissing")}
            </Notice>
          )}
        </fieldset>
        <InlineError error={save.error} />
        <div className="dialog-actions">
          <span className="muted small push-start">{t("note")}</span>
          {canWrite && !live && (
            <Button disabled={save.isPending} onClick={() => submit("draft")}>
              {t("saveDraft")}
            </Button>
          )}
          <Button onClick={() => setPreviewing(true)}>{t("previewBtn")}</Button>
          {canWrite && (
            <Button type="submit" variant="primary" disabled={save.isPending}>
              {live ? t("saveLive") : f.when === "schedule" ? t("publishScheduled") : t("publishNow")}
            </Button>
          )}
        </div>
      </form>
      {previewing && (
        <Modal open onOpenChange={(o) => !o && setPreviewing(false)} title={t("previewTitle")}>
          <div className="dialog-body">
            <PanelPreview entry={{ kind: f.kind, title: f.title, summary: f.summary, mediaUrl: f.mediaUrl || null, mediaKind: f.mediaKind, mediaAlt: f.mediaAlt, ctaLabel: f.ctaPath ? f.ctaLabel : null, displayDate: f.displayDate || null, publishedAt: entry?.publishedAt ?? null }} />
          </div>
        </Modal>
      )}
    </Drawer>
  );
}
