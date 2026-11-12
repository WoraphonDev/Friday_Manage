"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Check, ImagePlus, Info, X } from "lucide-react";
import { Button, Dialog, Input, Select, useToast } from "@/components/ui";
import { ApiError, lastRequestId } from "@/lib/api";
import { useIsMobile } from "@/lib/use-mobile";
import { helpApi, helpKeys, IMPACTS, MAX_FILE_BYTES, MAX_FILES, TICKET_CATEGORIES, uploadAttachment, type Duration, type TicketList } from "./shared";
import styles from "./help.module.css";

export interface ContactPrefill {
  articleSlug?: string;
  articleTitle?: string;
  searchQuery?: string;
  subject?: string;
  /** หน้าที่เปิดอยู่ (ชื่อที่อ่านได้ เช่น "แผนพัฒนา › Gantt") และ path */
  page?: string;
  path?: string;
}
export interface ContactWorkspace {
  slug: string;
  name: string;
  role: "owner" | "admin" | "member" | "guest";
}

export function useSlaText() {
  const t = useTranslations("help");
  return (d: Duration | null | undefined) => (d ? { n: d.n, unit: t(`units.${d.unit}`) } : null);
}

/** "Workspace · แพ็กเกจ · ตอบภายใน N ชั่วโมงทำการ" ของหัวฟอร์ม X5 */
function useContactMeta(workspace: ContactWorkspace, data: TicketList | undefined) {
  const t = useTranslations("help");
  const sla = useSlaText();
  if (!data) return null;
  const s = sla(data.sla.first);
  const plan = data.plan.name ?? data.plan.code;
  return s ? t("contact.meta", { workspace: workspace.name, plan, ...s }) : t("contact.metaNoSla", { workspace: workspace.name, plan });
}

/** ฟอร์มติดต่อทีม Support (X5) · ใช้ทั้งใน Dialog (เดสก์ท็อป) และหน้าเต็มจอ (มือถือ) */
export function ContactForm({ workspace, prefill = {}, onDone, onCancel, showMeta = true }: { workspace: ContactWorkspace; prefill?: ContactPrefill; onDone?: () => void; onCancel?: () => void; /** Dialog แสดงบรรทัดนี้ที่หัวแทน (ไม่ให้เลื่อนหายใต้เส้นหัว) */ showMeta?: boolean }) {
  const t = useTranslations("help");
  const toast = useToast();
  const cache = useQueryClient();
  const sla = useSlaText();
  const base = `/work/${encodeURIComponent(workspace.slug)}`;
  const info = useQuery({ queryKey: helpKeys.tickets(workspace.slug, "mine"), queryFn: () => helpApi.tickets(workspace.slug, "mine") });
  const [subject, setSubject] = useState(prefill.subject ?? prefill.searchQuery ?? "");
  const [category, setCategory] = useState("");
  const [impact, setImpact] = useState<(typeof IMPACTS)[number]>("me");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  // รหัสคำขอล่าสุดตอนเปิดฟอร์ม (คำขอของฟอร์มเองไม่ใช่สิ่งที่ลูกค้าต้องการแจ้ง)
  const [requestId] = useState(() => lastRequestId);
  const [withContext, setWithContext] = useState(true);
  const [grantAccess, setGrantAccess] = useState(false);
  const [touched, setTouched] = useState(false);
  const [sent, setSent] = useState<{ id: string; number: number; first: Duration | null; open: boolean } | null>(null);
  const page = prefill.page ?? t("routes.help");
  const path = prefill.path ?? `${base}/help`;

  // แนะนำบทความระหว่างพิมพ์หัวข้อ (ไม่นับเป็นการค้นหาในสถิติ)
  const [debounced, setDebounced] = useState(subject.trim());
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(subject.trim()), 250);
    return () => clearTimeout(timer);
  }, [subject]);
  const suggest = useQuery({
    queryKey: helpKeys.list(`suggest:${debounced}`),
    queryFn: () => helpApi.articles({ q: debounced, suggest: 1, limit: 3 }),
    enabled: debounced.length >= 3,
  });

  const submit = useMutation({
    mutationFn: async () => {
      const attachments = [];
      for (const file of files) attachments.push(await uploadAttachment(workspace.slug, file));
      const created = await helpApi.create(workspace.slug, {
        subject: subject.trim(),
        category,
        impact,
        body: body.trim(),
        attachments,
        ...(withContext ? { context: { page: page.slice(0, 200), path: path.slice(0, 300), ...(requestId ? { requestId } : {}) } } : {}),
        ...(prefill.articleSlug ? { articleSlug: prefill.articleSlug } : {}),
        ...(prefill.searchQuery ? { searchQuery: prefill.searchQuery } : {}),
      });
      if (grantAccess) {
        try {
          await helpApi.supportAccess(workspace.slug);
        } catch (error) {
          toast({ message: t("contact.accessFailed", { message: error instanceof Error ? error.message : "" }) });
        }
      }
      return created;
    },
    onSuccess: (r) => {
      setSent({ id: r.ticket.id, number: r.ticket.number, first: r.sla.first, open: r.sla.open });
      void cache.invalidateQueries({ queryKey: ["help", "tickets"] });
    },
  });

  const missing = !subject.trim() || subject.trim().length < 3 || !category || !body.trim();
  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (missing || submit.isPending) return;
    submit.mutate();
  }
  function addFiles(list: FileList | null) {
    if (!list) return;
    const next = [...files];
    for (const file of Array.from(list)) {
      if (file.size > MAX_FILE_BYTES) {
        setFileError(t("contact.tooLarge", { name: file.name }));
        continue;
      }
      if (next.length >= MAX_FILES) {
        setFileError(t("contact.tooMany"));
        break;
      }
      next.push(file);
    }
    setFiles(next);
  }

  const metaText = useContactMeta(workspace, info.data);
  if (sent) {
    const s = sla(sent.first);
    return (
      <div className={styles.sent} role="status">
        <span className={styles.sentIcon} aria-hidden="true">
          <Check size={18} />
        </span>
        <h3>{t("contact.sentTitle", { number: sent.number })}</h3>
        <p className="muted">{!s ? t("contact.sentNoSla") : sent.open ? t("contact.sentBody", s) : t("contact.sentOffHours")}</p>
        <div className={styles.sentActions}>
          <Button onClick={onDone}>{t("contact.close")}</Button>
          <Link className="button button-primary" href={`${base}/help/tickets?ticket=${sent.id}`} onClick={onDone}>
            {t("contact.view")}
          </Link>
        </div>
      </div>
    );
  }

  const apiError = submit.error instanceof ApiError ? submit.error : null;
  return (
    <form className={styles.contactForm} onSubmit={onSubmit} noValidate>
      {showMeta && metaText && <p className={styles.contactMeta}>{metaText}</p>}
      {(prefill.articleTitle || prefill.searchQuery) && (
        <p className={styles.contactNote}>{prefill.articleTitle ? t("contact.article", { title: prefill.articleTitle }) : t("contact.fromSearch", { q: prefill.searchQuery! })}</p>
      )}
      <Input
        label={`${t("contact.subject")} *`}
        value={subject}
        maxLength={200}
        onChange={(e) => setSubject(e.target.value)}
        error={touched && subject.trim().length < 3 ? t("contact.required", { field: t("contact.subject") }) : undefined}
        autoFocus
      />
      {!!suggest.data?.items.length && (
        <div className={styles.suggest} aria-live="polite">
          <b>{t("contact.suggestions")}</b>
          {suggest.data.items.map((a) => (
            <Link key={a.id} href={`${base}/help/${a.slug}`} onClick={onCancel}>
              {a.title}
            </Link>
          ))}
          <span className="muted">{t("contact.suggestionsHint")}</span>
        </div>
      )}
      <div className={styles.contactRow}>
        <Select label={`${t("contact.category")} *`} value={category} onChange={(e) => setCategory(e.target.value)} error={touched && !category ? t("contact.required", { field: t("contact.category") }) : undefined}>
          <option value="">{t("contact.categoryPick")}</option>
          {TICKET_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`categories.${c}`)}
            </option>
          ))}
        </Select>
        <Select label={t("contact.impact")} value={impact} onChange={(e) => setImpact(e.target.value as (typeof IMPACTS)[number])}>
          {IMPACTS.map((i) => (
            <option key={i} value={i}>
              {t(`impacts.${i}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="field">
        <label htmlFor="help-contact-body">{t("contact.body")} *</label>
        <textarea id="help-contact-body" className="input" rows={4} maxLength={10000} value={body} onChange={(e) => setBody(e.target.value)} aria-invalid={touched && !body.trim() ? true : undefined} />
        {touched && !body.trim() && (
          <span className="field-error" role="alert">
            {t("contact.required", { field: t("contact.body") })}
          </span>
        )}
      </div>
      <FileDrop label={t("contact.attach")} onFiles={addFiles} />
      {fileError && (
        <span className="field-error" role="alert">
          {fileError}
        </span>
      )}
      {files.length > 0 && (
        <ul className={styles.fileList}>
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <span>{f.name}</span>
              <Button variant="ghost" size="icon" aria-label={t("contact.attachRemove", { name: f.name })} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                <X size={14} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <label className={styles.check}>
        <input type="checkbox" checked={withContext} onChange={(e) => setWithContext(e.target.checked)} />
        <span>{requestId ? t("contact.context", { page, requestId }) : t("contact.contextNoId", { page })}</span>
      </label>
      {workspace.role === "owner" && (
        <label className={styles.check}>
          <input type="checkbox" checked={grantAccess} onChange={(e) => setGrantAccess(e.target.checked)} />
          <span>{t("contact.access")}</span>
        </label>
      )}
      {apiError && (
        <p className="field-error" role="alert">
          {apiError.message}
        </p>
      )}
      <div className={styles.contactFoot}>
        <span className={styles.contactFootNote}>
          <Info size={14} aria-hidden="true" />
          {t("contact.footer")}
        </span>
        <Button onClick={onCancel}>{t("contact.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={submit.isPending}>
          {submit.isPending ? t("contact.sending") : t("contact.send")}
        </Button>
      </div>
    </form>
  );
}

function FileDrop({ label, onFiles }: { label: string; onFiles: (files: FileList | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={styles.drop}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onFiles(e.dataTransfer.files);
      }}
    >
      <button type="button" className={styles.dropButton} onClick={() => input.current?.click()}>
        <ImagePlus size={16} aria-hidden="true" />
        {label}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label={label}
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/**
 * เปิดฟอร์มติดต่อ Support · เดสก์ท็อปเป็น Dialog ในหน้าเดิม · มือถือ (390) ไปหน้าเต็มจอ /help/contact
 * Guest ไม่มีปุ่มนี้ (ผู้เรียกซ่อนเอง) · API ตอบ 403 ซ้ำอีกชั้น
 */
export function useContactSupport(workspace: ContactWorkspace) {
  const t = useTranslations("help.contact");
  const router = useRouter();
  const mobile = useIsMobile();
  const [prefill, setPrefill] = useState<ContactPrefill | null>(null);
  const info = useQuery({ queryKey: helpKeys.tickets(workspace.slug, "mine"), queryFn: () => helpApi.tickets(workspace.slug, "mine"), enabled: !!prefill });
  const meta = useContactMeta(workspace, info.data);
  const open = (p: ContactPrefill = {}) => {
    if (mobile) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(p)) if (v) q.set(k, v);
      const qs = q.toString();
      router.push(`/work/${encodeURIComponent(workspace.slug)}/help/contact${qs ? `?${qs}` : ""}`);
      return;
    }
    setPrefill(p);
  };
  const element = (
    <Dialog open={!!prefill} onOpenChange={(o) => !o && setPrefill(null)} title={t("title")} description={meta ?? undefined} size="medium">
      {prefill && <ContactForm workspace={workspace} prefill={prefill} showMeta={false} onDone={() => setPrefill(null)} onCancel={() => setPrefill(null)} />}
    </Dialog>
  );
  return { open, element };
}
