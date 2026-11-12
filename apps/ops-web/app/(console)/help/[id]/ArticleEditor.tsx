"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { hasAny } from "@/components/access";
import { Chip, Drawer, Empty, ErrorBlock, Modal, Notice, TableSkeleton } from "@/components/kit";
import { Button, errorToast, InlineError, Input, Pill, Select, Textarea, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useFmt } from "../../workspaces/_parts/format";
import { Markdown } from "../_components/markdown";
import { APP_ROUTES, type Article, type ArticleDetail, type Category, HELP_KEY, type Visibility } from "../_components/types";
import styles from "../help.module.css";

/** ช่องที่บันทึกอัตโนมัติได้ (PATCH ops/help/articles/:id) */
type Fields = Pick<Article, "slug" | "categoryId" | "title" | "summary" | "body" | "titleEn" | "summaryEn" | "bodyEn" | "visibility" | "appRoutes" | "keywords" | "reviewAt">;
const FIELD_KEYS: (keyof Fields)[] = ["slug", "categoryId", "title", "summary", "body", "titleEn", "summaryEn", "bodyEn", "visibility", "appRoutes", "keywords", "reviewAt"];
/** หน่วงก่อนบันทึกอัตโนมัติ (ms) */
export const AUTOSAVE_MS = 1500;

const pick = (a: Article): Fields => Object.fromEntries(FIELD_KEYS.map((k) => [k, a[k]])) as Fields;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const nullable = (v: string) => (v.trim() ? v : null);
const hhmm = (iso: string) => new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }).format(new Date(iso));

/** บอร์ด 19b · ตัวแก้บทความ: Markdown + ตัวอย่าง · บันทึกร่างอัตโนมัติ · เผยแพร่ต้องติ๊กตรวจข้อมูลลูกค้า · เวอร์ชันและย้อนกลับ */
export function ArticleEditor({ id }: { id: string }) {
  const t = useTranslations("help.editor");
  const tr = useTranslations("help.routes");
  const fmt = useFmt();
  const toast = useToast();
  const router = useRouter();
  const cache = useQueryClient();
  const me = useMe().data;
  const key = [...HELP_KEY, "article", id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<ArticleDetail>(`/help/articles/${id}`) });
  const categories = useQuery({ queryKey: [...HELP_KEY, "categories"], queryFn: () => api.get<{ items: Category[] }>("/help/categories") });
  const [form, setForm] = useState<Fields | null>(null);
  const saved = useRef<Fields | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [preview, setPreview] = useState(false);
  const [english, setEnglish] = useState(false);
  const [dialog, setDialog] = useState<"publish" | "archive" | "discard" | "delete" | "versions" | null>(null);
  const body = useRef<HTMLTextAreaElement>(null);

  // โหลดครั้งแรก / หลังเผยแพร่ ย้อนกลับ ทิ้งร่าง: ตั้งฟอร์มจากข้อมูลล่าสุด
  const load = useCallback((a: Article) => {
    const f = pick(a);
    saved.current = f;
    setForm(f);
    setSavedAt(a.draftSavedAt);
    setEnglish(!!(a.titleEn || a.bodyEn));
  }, []);
  useEffect(() => {
    if (q.data && !saved.current) load(q.data.article);
  }, [q.data, load]);

  const canEdit = !!q.data?.canEdit && hasAny(me, "owner", "support");
  const article = q.data?.article;

  /** ส่งเฉพาะช่องที่เปลี่ยนจากที่บันทึกล่าสุด */
  const save = useCallback(async () => {
    if (!form || !saved.current) return true;
    const diff = Object.fromEntries(FIELD_KEYS.filter((k) => !same(form[k], saved.current![k])).map((k) => [k, form[k]]));
    if (!Object.keys(diff).length) return true;
    setSaving(true);
    try {
      const r = await api.patch<{ savedAt: string; article: Article }>(`/help/articles/${id}`, diff);
      saved.current = { ...saved.current, ...(diff as Partial<Fields>) };
      setSavedAt(r.savedAt);
      setSaveError(null);
      cache.setQueryData<ArticleDetail>(key, (d) => (d ? { ...d, article: r.article } : d));
      return true;
    } catch (e) {
      setSaveError(e);
      return false;
    } finally {
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, id]);

  const dirty = !!form && !!saved.current && FIELD_KEYS.some((k) => !same(form[k], saved.current![k]));
  useEffect(() => {
    if (!dirty || !canEdit) return;
    const timer = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [dirty, canEdit, save]);

  const set = <K extends keyof Fields>(k: K, v: Fields[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  /** แทรกไวยากรณ์ Markdown ที่ตำแหน่งเคอร์เซอร์ · ข้อความที่เลือกไว้ถูกครอบ · `block` = ขึ้นบรรทัดใหม่ก่อน (หัวข้อ รายการ กล่องเตือน) */
  const insert = (before: string, sample = "", after = "", block = false) => {
    if (!form) return;
    const el = body.current;
    const caret = el?.selectionEnd ?? form.body.length;
    // บล็อกขึ้นต่อท้ายบรรทัดที่เคอร์เซอร์อยู่ ไม่ตัดกลางบรรทัด
    const eol = form.body.indexOf("\n", caret);
    const end = block ? (eol === -1 ? form.body.length : eol) : caret;
    const start = block ? end : (el?.selectionStart ?? end);
    const picked = (block ? "" : form.body.slice(start, end)) || sample;
    const lead = block && start > 0 && form.body[start - 1] !== "\n" ? "\n" : "";
    const next = `${form.body.slice(0, start)}${lead}${before}${picked}${after}${form.body.slice(end)}`;
    set("body", next);
    const at = start + lead.length + before.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at, at + picked.length);
    });
  };
  const line = (prefix: string, sample: string, after = "") => insert(prefix, sample, after, true);
  const tt = useTranslations("help.editor.tool");

  if (q.isPending) return <TableSkeleton rows={6} cols={2} />;
  if (q.error) {
    if (q.error instanceof ApiError && q.error.status === 404)
      return (
        <Empty
          title={t("notFound")}
          action={
            <Link className="button" href="/help">
              {t("back")}
            </Link>
          }
        />
      );
    return <ErrorBlock error={q.error} retry={() => void q.refetch()} />;
  }
  if (!form || !article) return <TableSkeleton rows={6} cols={2} />;
  const cats = categories.data?.items ?? [];
  const published = article.status === "published";
  const status = saving ? t("saving") : dirty ? t("unsaved") : savedAt ? t("savedAt", { time: hhmm(savedAt) }) : null;

  return (
    <>
      <div className={styles.editorHead}>
        <div>
          <nav className={styles.crumbs} aria-label="breadcrumb">
            <Link href="/help">{t("crumb")}</Link> › {form.title || "—"}
          </nav>
          <h1>{t("title")}</h1>
        </div>
        <div className={styles.editorActions}>
          {/* แสดงสถานะครั้งเดียว: เผยแพร่แล้วและไม่มีร่างค้าง = ป้ายเขียว · นอกนั้น = บรรทัด "ร่าง · บันทึกอัตโนมัติ HH:MM" */}
          {published && !article.hasDraft && !dirty && !saving ? (
            <Pill tone="ok">{t("publishedV", { v: article.version })}</Pill>
          ) : (
            <span className={styles.saved} role="status">
              {published ? t("pendingDraft") : t("draft")}
              {status && ` · ${status}`}
            </span>
          )}
          <Button aria-pressed={preview} onClick={() => setPreview((v) => !v)}>
            {preview ? t("edit") : t("preview")}
          </Button>
          {canEdit && (
            <Button
              variant="primary"
              onClick={async () => {
                if (!form.title.trim() || !form.body.trim()) return toast({ message: t("required") });
                if (await save()) setDialog("publish");
              }}
            >
              {published ? t("republish") : t("publish")}
            </Button>
          )}
        </div>
      </div>
      {!canEdit && <Notice tone="info" title={t("readOnly")} />}
      <InlineError error={saveError} />

      <div className={styles.editor}>
        <section className="card stack">
          <Input label={`${t("name")} *`} value={form.title} readOnly={!canEdit} onChange={(e) => set("title", e.target.value)} />
          <div className={styles.pair}>
            <Input label={t("slug")} value={form.slug} readOnly={!canEdit} hint={`/help/${form.slug} · ${t("slugHint")}`} onChange={(e) => set("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} />
            <Textarea label={t("summary")} rows={2} value={form.summary ?? ""} readOnly={!canEdit} onChange={(e) => set("summary", nullable(e.target.value))} />
          </div>
          <div className="field">
            <span className="field-label" id="body-label">
              {t("body")} *
            </span>
            <div className={styles.bodyBox}>
              {canEdit && !preview && (
                <div className={styles.toolbar} role="toolbar" aria-label={tt("label")}>
                  <button type="button" onClick={() => line("## ", tt("sampleHeading"))}>
                    {tt("heading")}
                  </button>
                  <button type="button" aria-label={tt("boldLabel")} onClick={() => insert("**", tt("sampleText"), "**")}>
                    <b>{tt("bold")}</b>
                  </button>
                  <button type="button" aria-label={tt("italicLabel")} onClick={() => insert("*", tt("sampleText"), "*")}>
                    <i>{tt("italic")}</i>
                  </button>
                  <button type="button" aria-label={tt("listLabel")} onClick={() => line("1. ", tt("sampleText"))}>
                    {tt("list")}
                  </button>
                  <button type="button" onClick={() => insert("[", tt("sampleLink"), "](https://)")}>
                    {tt("link")}
                  </button>
                  <button type="button" title={t("imageHint")} onClick={() => insert("![", tt("sampleImage"), "](https://)")}>
                    {tt("image")}
                  </button>
                  <button type="button" onClick={() => line(":::warning\n", tt("sampleCallout"), "\n:::")}>
                    {tt("callout")}
                  </button>
                  <button type="button" onClick={() => insert("[", tt("sampleApp"), "](app:/admin/trash)")}>
                    {tt("appLink")}
                  </button>
                </div>
              )}
              {preview ? (
                <div className={styles.preview} aria-label={t("preview")}>
                  <Markdown source={form.body} />
                </div>
              ) : (
                <textarea ref={body} className={styles.bodyText} aria-labelledby="body-label" value={form.body} readOnly={!canEdit} onChange={(e) => set("body", e.target.value)} />
              )}
            </div>
            <span className="muted small">{t("bodyHint")}</span>
            <span className="muted small">{t("imageHint")}</span>
          </div>
          {english && (
            <>
              <Input label={t("titleEn")} value={form.titleEn ?? ""} readOnly={!canEdit} onChange={(e) => set("titleEn", nullable(e.target.value))} />
              <Textarea label={t("summaryEn")} rows={2} value={form.summaryEn ?? ""} readOnly={!canEdit} onChange={(e) => set("summaryEn", nullable(e.target.value))} />
              {preview ? <Markdown source={form.bodyEn ?? ""} /> : <Textarea label={t("bodyEn")} rows={10} value={form.bodyEn ?? ""} readOnly={!canEdit} onChange={(e) => set("bodyEn", nullable(e.target.value))} />}
            </>
          )}
        </section>

        <aside className={`card ${styles.side}`}>
          <Select label={`${t("category")} *`} value={form.categoryId} disabled={!canEdit} onChange={(e) => set("categoryId", e.target.value)}>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <fieldset className="stack-tight" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">{t("visibility")}</legend>
            {(["public", "signed_in"] as Visibility[]).map((v) => (
              <label key={v} className={`${styles.radioCard} ${form.visibility === v ? styles.radioOn : ""}`}>
                <input type="radio" name="visibility" value={v} checked={form.visibility === v} disabled={!canEdit} onChange={() => set("visibility", v)} />
                <span>
                  <b>{v === "public" ? t("public") : t("signedIn")}</b>
                  <span className="muted small">{v === "public" ? t("publicNote") : t("signedInNote")}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">{t("routes")}</legend>
            <div className={styles.routes}>
              {APP_ROUTES.map((r) => {
                const on = form.appRoutes.includes(r);
                return (
                  <Chip key={r} pressed={on} onClick={() => canEdit && set("appRoutes", on ? form.appRoutes.filter((x) => x !== r) : [...form.appRoutes, r])}>
                    {tr(r.replace(".", "_") as "home")}
                  </Chip>
                );
              })}
            </div>
            <span className="muted small">{t("routesHint")}</span>
          </fieldset>
          <Input label={t("keywords")} value={form.keywords ?? ""} readOnly={!canEdit} hint={t("keywordsHint")} onChange={(e) => set("keywords", nullable(e.target.value))} />
          <Input label={t("reviewAt")} type="date" value={form.reviewAt ?? ""} readOnly={!canEdit} onChange={(e) => set("reviewAt", e.target.value || null)} />
          <Select label={t("english")} value={english ? "on" : "off"} disabled={!canEdit && !english} onChange={(e) => setEnglish(e.target.value === "on")}>
            <option value="off">{t("englishNone")}</option>
            <option value="on">{t("englishOn")}</option>
          </Select>
          {q.data.sourceTicket && (
            <div className={styles.kv}>
              <span className="muted">{t("fromTicket")}</span>
              <Link href={`/support?ticket=${q.data.sourceTicket.id}`}>#{q.data.sourceTicket.number}</Link>
            </div>
          )}
          <div className={styles.kv}>
            <span className="muted">{t("history")}</span>
            {q.data.versions.length ? (
              <button type="button" className="link-button" onClick={() => setDialog("versions")}>
                {t("versionsN", { n: q.data.versions.length })}
              </button>
            ) : (
              <span className="muted">{t("noVersions")}</span>
            )}
          </div>
          {canEdit && (
            <div className="row" style={{ flexWrap: "wrap" }}>
              {published && article.hasDraft && (
                <Button size="small" onClick={() => setDialog("discard")}>
                  {t("discard")}
                </Button>
              )}
              {published && (
                <Button size="small" onClick={() => setDialog("archive")}>
                  {t("archive")}
                </Button>
              )}
              <Button size="small" variant="danger" onClick={() => setDialog("delete")}>
                {t("delete")}
              </Button>
            </div>
          )}
        </aside>
      </div>

      {dialog === "publish" && (
        <PublishDialog
          article={{ ...article, title: form.title, visibility: form.visibility }}
          onClose={() => setDialog(null)}
          onDone={(a) => {
            load(a);
            void cache.invalidateQueries({ queryKey: HELP_KEY });
          }}
        />
      )}
      {(dialog === "archive" || dialog === "discard" || dialog === "delete") && (
        <ActionDialog
          kind={dialog}
          title={form.title}
          id={id}
          onClose={() => setDialog(null)}
          onDone={(a) => {
            void cache.invalidateQueries({ queryKey: HELP_KEY });
            if (dialog === "delete") return router.push("/help");
            if (a) load(a);
          }}
        />
      )}
      <Drawer open={dialog === "versions"} onOpenChange={(o) => !o && setDialog(null)} title={t("versionsTitle")} description={t("versionsDesc")}>
        <ul className={styles.versions}>
          {q.data.versions.map((v) => (
            <li key={v.version}>
              <span>
                <b>{t("version", { v: v.version })}</b>
                <span className="muted small" style={{ display: "block" }}>
                  {t("versionBy", { when: fmt.dateTime(v.publishedAt), by: v.publishedBy ?? "—" })}
                </span>
              </span>
              {published && v.version === article.version ? (
                <Pill tone="ok">{t("current")}</Pill>
              ) : (
                canEdit && <RestoreButton id={id} version={v.version} onDone={(a) => (load(a), setDialog(null), void cache.invalidateQueries({ queryKey: HELP_KEY }))} />
              )}
            </li>
          ))}
        </ul>
      </Drawer>
    </>
  );
}

function RestoreButton({ id, version, onDone }: { id: string; version: number; onDone: (a: Article) => void }) {
  const t = useTranslations("help.editor");
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => api.post<{ article: Article }>(`/help/articles/${id}/versions/${version}/restore`),
    onSuccess: (r) => (toast({ message: t("restored", { v: version }) }), onDone(r.article)),
    onError: (e) => toast(errorToast(e)),
  });
  return (
    <Button size="small" disabled={m.isPending} onClick={() => m.mutate()} aria-label={`${t("restore")} ${t("version", { v: version })}`}>
      {t("restore")}
    </Button>
  );
}

/** เผยแพร่: ต้องติ๊กตรวจว่าไม่มีข้อมูลลูกค้า (ops-api ตอบ 422 pii_check_required ถ้าไม่ติ๊ก) */
function PublishDialog({ article, onClose, onDone }: { article: Article; onClose: () => void; onDone: (a: Article) => void }) {
  const t = useTranslations("help.editor");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const [pii, setPii] = useState(false);
  const m = useMutation({
    mutationFn: () => api.post<{ article: Article }>(`/help/articles/${article.id}/publish`, { piiChecked: true }),
    onSuccess: (r) => (toast({ message: t("published") }), onDone(r.article), onClose()),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("publishTitle", { title: article.title })} description={t("publishDesc", { public: article.visibility === "public" ? "yes" : "no" })}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), pii && m.mutate())}>
        <label className="check">
          <input type="checkbox" checked={pii} onChange={(e) => setPii(e.target.checked)} />
          <span>{t("pii")}</span>
        </label>
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!pii || m.isPending}>
            {t("publish")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ActionDialog({ kind, id, title, onClose, onDone }: { kind: "archive" | "discard" | "delete"; id: string; title: string; onClose: () => void; onDone: (a: Article | null) => void }) {
  const t = useTranslations("help.editor");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const m = useMutation({
    mutationFn: () =>
      kind === "delete" ? api.delete<{ deleted: true }>(`/help/articles/${id}`).then(() => null) : api.post<{ article: Article }>(`/help/articles/${id}/${kind === "archive" ? "archive" : "discard-draft"}`).then((r) => r.article),
    onSuccess: (a) => (toast({ message: t(kind === "archive" ? "archived" : kind === "discard" ? "discarded" : "deleted") }), onClose(), onDone(a)),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t(`${kind}Title`, { title })} description={t(`${kind}Desc`)}>
      <div className="dialog-body">
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button variant={kind === "delete" ? "danger" : "primary"} disabled={m.isPending} onClick={() => m.mutate()}>
            {t(kind)}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
