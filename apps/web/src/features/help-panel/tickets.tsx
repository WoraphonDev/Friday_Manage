"use client";

import { useContext, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ArrowLeft, Download, ImagePlus, X } from "lucide-react";
import { Badge, Button, EmptyState, ErrorState, Forbidden, LoadingState, NotFound, YearFormatContext, useToast, type Tone } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { formatDate, localeDateFormat } from "@/lib/format";
import { useIsMobile } from "@/lib/use-mobile";
import { cn } from "@/lib/utils";
import { useContactSupport, type ContactWorkspace } from "./contact";
import { helpApi, helpKeys, MAX_FILE_BYTES, MAX_FILES, REOPEN_DAYS, uploadAttachment, type SupportTicket, type TicketMessage, type TicketStatus } from "./shared";
import styles from "./help.module.css";

const STATUS_TONE: Record<TicketStatus, Tone> = { open: "amber", pending_customer: "blue", pending_dev: "purple", solved: "green", closed: "neutral" };

function useWhen() {
  const year = useContext(YearFormatContext);
  return (iso: string | null | undefined) => {
    if (!iso) return "";
    const d = new Date(iso);
    const time = localeDateFormat({ hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Bangkok" }).format(d);
    const day = (x: Date) => x.toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
    return day(d) === day(new Date()) ? time : `${formatDate(d, year)} ${time}`;
  };
}

export function StatusChip({ status }: { status: TicketStatus }) {
  const t = useTranslations("help.status");
  return <Badge tone={STATUS_TONE[status]}>{t(status)}</Badge>;
}

/** ขั้นความคืบหน้าที่ลูกค้าเห็น (X6 · T12) · ไม่บอกเลขงานของทีมพัฒนา */
function Steps({ ticket }: { ticket: SupportTicket }) {
  const t = useTranslations("help.tickets.steps");
  const when = useWhen();
  const finished = ticket.status === "solved" || ticket.status === "closed";
  const steps: { key: string; done: boolean; current: boolean; at?: string | null }[] = [
    { key: "sent", done: true, current: false, at: ticket.createdAt },
    { key: "review", done: !!ticket.firstRespondedAt || ticket.status !== "open", current: ticket.status === "open" && !ticket.firstRespondedAt },
    ...(ticket.dev ? [{ key: "dev", done: true, current: false, at: ticket.dev.sentAt }] : []),
    { key: "fixed", done: finished, current: false, at: ticket.solvedAt ?? ticket.closedAt },
  ];
  return (
    <ol className={styles.steps}>
      {steps.map((s) => (
        <li key={s.key} className={cn(s.done && styles.stepDone, s.current && styles.stepCurrent)} aria-current={s.current ? "step" : undefined}>
          <span className={styles.stepDot} aria-hidden="true" />
          {t(s.key)}
          {s.done && s.at ? ` · ${when(s.at)}` : ""}
        </li>
      ))}
    </ol>
  );
}

function Bubble({ m }: { m: TicketMessage }) {
  const t = useTranslations("help.tickets");
  const when = useWhen();
  if (m.author === "system")
    return (
      <div className={styles.system}>
        <span>{m.body}</span>
      </div>
    );
  const staff = m.author === "staff";
  return (
    <div className={cn(styles.bubble, staff && styles.bubbleStaff)}>
      <p className={styles.bubbleHead}>
        <b>{staff ? t("team") : (m.authorName ?? t("me"))}</b> <span className="muted">{when(m.createdAt)}</span>
      </p>
      <p className={styles.bubbleBody}>{m.body}</p>
      {m.context?.page && <p className={styles.bubbleMeta}>{m.context.requestId ? t("attachedId", { page: m.context.page, requestId: m.context.requestId }) : t("attached", { page: m.context.page })}</p>}
      {m.article && <p className={styles.bubbleMeta}>{t("attachedArticle", { title: m.article.title })}</p>}
      {m.files.length > 0 && (
        <ul className={styles.bubbleFiles}>
          {m.files.map((f) => (
            <li key={f.url}>
              <a href={f.url} download={f.name}>
                <Download size={14} aria-hidden="true" />
                {f.name}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Detail({ ws, id, onBack }: { ws: string; id: string; onBack?: () => void }) {
  const t = useTranslations("help.tickets");
  const toast = useToast();
  const cache = useQueryClient();
  const when = useWhen();
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const reply = useRef<HTMLTextAreaElement>(null);
  const detail = useQuery({ queryKey: helpKeys.ticket(ws, id), queryFn: () => helpApi.ticket(ws, id), retry: false });
  const refresh = () => Promise.all([cache.invalidateQueries({ queryKey: helpKeys.ticket(ws, id) }), cache.invalidateQueries({ queryKey: ["help", "tickets"] })]);
  const onError = (e: Error) => toast({ message: e.message });
  const send = useMutation({
    mutationFn: async () => {
      const attachments = [];
      for (const f of files) attachments.push(await uploadAttachment(ws, f));
      return helpApi.reply(ws, id, { body: body.trim(), attachments });
    },
    onSuccess: () => {
      setBody("");
      setFiles([]);
      toast({ message: t("sent") });
      void refresh();
    },
    onError,
  });
  const close = useMutation({ mutationFn: () => helpApi.close(ws, id), onSuccess: () => (toast({ message: t("closed") }), void refresh()), onError });
  const reopen = useMutation({
    mutationFn: () => helpApi.reopen(ws, id),
    onSuccess: () => {
      toast({ message: t("reopened") });
      void refresh().then(() => reply.current?.focus());
    },
    onError,
  });

  if (detail.isPending) return <LoadingState />;
  if (detail.error) return detail.error instanceof ApiError && detail.error.status === 404 ? <NotFound /> : <ErrorState error={detail.error} retry={() => void detail.refetch()} />;
  const { ticket, messages } = detail.data;
  const solved = ticket.status === "solved";
  const closed = ticket.status === "closed";
  return (
    <section className={cn(styles.card, styles.ticketDetail)} aria-label={`#${ticket.number} ${ticket.subject}`}>
      {onBack && (
        <button type="button" className="page-back" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" />
          {t("back")}
        </button>
      )}
      <div className={styles.ticketHead}>
        <span className="muted">#{ticket.number}</span>
        <h2>{ticket.subject}</h2>
        <StatusChip status={ticket.status} />
        {ticket.firstResponseDueAt && !solved && !closed && <span className={styles.due}>{t("replyBy", { time: when(ticket.firstResponseDueAt) })}</span>}
      </div>
      {!ticket.mine && ticket.requester?.name && <p className="muted">{t("requester", { name: ticket.requester.name })}</p>}
      <Steps ticket={ticket} />
      <div className={styles.thread}>
        {messages.map((m) => (
          <Bubble key={m.id} m={m} />
        ))}
      </div>
      {solved && ticket.canReopen && (
        <div className={styles.solvedBar}>
          <p>{t("solvedNote", { days: REOPEN_DAYS })}</p>
          <div className={styles.rowEnd}>
            <Button disabled={reopen.isPending} onClick={() => reopen.mutate()}>
              {t("stillIssue")}
            </Button>
            <Button variant="primary" disabled={close.isPending} onClick={() => close.mutate()}>
              {t("thanks")}
            </Button>
          </div>
        </div>
      )}
      {solved && !ticket.canReopen && (
        <div className={styles.solvedBar}>
          <p>{t("closedFinal")}</p>
        </div>
      )}
      {closed && (
        <div className={styles.solvedBar}>
          <p>{ticket.canReopen ? t("closedNote") : t("closedFinal")}</p>
          {ticket.canReopen && (
            <div className={styles.rowEnd}>
              <Button disabled={reopen.isPending} onClick={() => reopen.mutate()}>
                {t("reopen")}
              </Button>
            </div>
          )}
        </div>
      )}
      {ticket.canReply && !solved && (
        <form
          className={styles.replyBox}
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim() && !send.isPending) send.mutate();
          }}
        >
          <textarea ref={reply} className="input" rows={3} placeholder={t("replyPlaceholder")} aria-label={t("replyLabel")} value={body} onChange={(e) => setBody(e.target.value)} maxLength={10000} />
          {files.length > 0 && (
            <ul className={styles.fileList}>
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`}>
                  <span>{f.name}</span>
                  <Button variant="ghost" size="icon" aria-label={f.name} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                    <X size={14} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className={styles.replyActions}>
            <Button onClick={() => fileInput.current?.click()} disabled={files.length >= MAX_FILES}>
              <ImagePlus size={16} aria-hidden="true" />
              {t("attach")}
            </Button>
            <input
              ref={fileInput}
              type="file"
              hidden
              multiple
              aria-label={t("attach")}
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []).filter((f) => f.size <= MAX_FILE_BYTES);
                setFiles([...files, ...picked].slice(0, MAX_FILES));
                e.target.value = "";
              }}
            />
            <span className={styles.spacer} />
            {ticket.canClose && (
              <Button disabled={close.isPending} onClick={() => close.mutate()}>
                {t("closeTicket")}
              </Button>
            )}
            <Button type="submit" variant="primary" disabled={!body.trim() || send.isPending}>
              {t("send")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

/** X6 · Ticket ของฉัน · Owner / Admin สลับดูทั้ง Workspace ได้ · ?ticket=<id> เลือกเรื่อง (ลิงก์จากอีเมล / กระดิ่ง) */
export function TicketsPage({ workspace }: { workspace: ContactWorkspace }) {
  const t = useTranslations("help.tickets");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const mobile = useIsMobile();
  const when = useWhen();
  const [scope, setScope] = useState<"mine" | "workspace">("mine");
  const selectedParam = params.get("ticket");
  const list = useQuery({ queryKey: helpKeys.tickets(workspace.slug, scope), queryFn: () => helpApi.tickets(workspace.slug, scope) });
  const contact = useContactSupport(workspace);
  const select = (id: string | null) => router.replace(id ? `${pathname}?ticket=${encodeURIComponent(id)}` : pathname, { scroll: false });

  if (list.isPending) return <LoadingState />;
  if (list.error) return list.error instanceof ApiError && list.error.status === 403 ? <Forbidden /> : <ErrorState error={list.error} retry={() => void list.refetch()} />;
  const { items, canViewWorkspace, canContact } = list.data;
  const selected = selectedParam ?? (mobile ? null : (items[0]?.id ?? null));
  const showList = !mobile || !selected;
  const showDetail = !mobile || !!selected;

  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <div>
          <h1>{t("title")}</h1>
          <p className="muted">{t("subtitle")}</p>
        </div>
        <div className={styles.rowEnd}>
          {canViewWorkspace && (
            <div className={styles.segmented} role="group" aria-label={t("scope")}>
              {(["mine", "workspace"] as const).map((s) => (
                <button key={s} type="button" aria-pressed={scope === s} onClick={() => setScope(s)}>
                  {t(s)}
                </button>
              ))}
            </div>
          )}
          {canContact && workspace.role !== "guest" && (
            <Button variant="primary" onClick={() => contact.open({ page: t("title"), path: pathname })}>
              {t("contact")}
            </Button>
          )}
        </div>
      </header>
      {!items.length ? (
        <section className={styles.card}>
          <EmptyState title={t("empty")} description={canContact ? t("emptyHint") : ""} />
        </section>
      ) : (
        <div className={styles.ticketLayout}>
          {showList && (
            <ul className={cn(styles.card, styles.ticketList)} aria-label={t("listLabel")}>
              {items.map((x) => (
                <li key={x.id}>
                  <button type="button" className={styles.ticketItem} aria-current={x.id === selected ? "true" : undefined} onClick={() => select(x.id)}>
                    <span className={styles.ticketItemTop}>
                      <span className="muted">#{x.number}</span>
                      <StatusChip status={x.status} />
                    </span>
                    <strong>{x.subject}</strong>
                    <small className="muted">{t("createdBy", { name: x.requester?.name ?? t("me"), date: when(x.lastMessageAt) })}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {showDetail &&
            (selected ? (
              <Detail key={selected} ws={workspace.slug} id={selected} onBack={mobile ? () => select(null) : undefined} />
            ) : (
              <section className={styles.card}>
                <EmptyState title={t("select")} description="" />
              </section>
            ))}
        </div>
      )}
      {contact.element}
    </div>
  );
}
