"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { Button, Input } from "@/components/ui";
import { api } from "@/lib/api";
import styles from "./public.module.css";
import { SiteFooter, SiteHeader } from "./site";

interface PublicQuote {
  number: string;
  company: string;
  status: "sent" | "accepted" | "expired" | "declined" | "draft";
  seats: number;
  months: number;
  pricePerSeatSatang: number;
  subtotalSatang: number;
  vatSatang: number;
  totalSatang: number;
  entitlements: { sso?: boolean; api_rpm?: number | null; storage_gb?: number | null };
  sla: { first: { n: number; unit: "h" | "d" }; resolve: { n: number; unit: "h" | "d" } } | null;
  contractStart: string | null;
  validUntil: string;
  acceptedBy: string | null;
}

/** หน้าตอบรับใบเสนอราคาของลูกค้า (O55) · ไม่ต้องล็อกอิน · พิมพ์ / บันทึก PDF จากเบราว์เซอร์ · ตอบรับ หรือขอแก้ไข (เปิด Ticket) */
export function QuotePage({ token }: { token: string }) {
  const t = useTranslations("saas-pages.quote");
  const f = useFormatter();
  const cache = useQueryClient();
  const key = ["public-quote", token];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<PublicQuote>(`/public/quotes/${encodeURIComponent(token)}`), retry: false });
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [po, setPo] = useState("");
  const [agree, setAgree] = useState(false);
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const accept = useMutation({
    mutationFn: () => api.post<PublicQuote>(`/public/quotes/${encodeURIComponent(token)}/accept`, { name: name.trim(), title: title.trim(), agree: true, ...(po.trim() ? { po: po.trim() } : {}) }),
    onSuccess: (r) => cache.setQueryData(key, r),
  });
  const change = useMutation({ mutationFn: () => api.post(`/public/quotes/${encodeURIComponent(token)}/changes`, { message: message.trim(), ...(email.trim() ? { email: email.trim() } : {}) }) });
  const money = (s: number) => f.number(s / 100, { style: "currency", currency: "THB" });
  const date = (d: string) => f.dateTime(new Date(`${d}T00:00:00+07:00`), { dateStyle: "long" });
  const dur = (x: { n: number; unit: "h" | "d" }) => (x.unit === "h" ? t("hours", { n: x.n }) : t("days", { n: x.n }));
  const d = q.data;
  const ents = d ? [d.entitlements.sso ? t("sso") : null, d.entitlements.api_rpm ? t("api", { n: d.entitlements.api_rpm }) : null, d.entitlements.storage_gb ? t("storage", { n: d.entitlements.storage_gb }) : null, d.sla ? t("sla", { first: dur(d.sla.first), resolve: dur(d.sla.resolve) }) : null].filter(Boolean) : [];
  return (
    <div className={styles.page}>
      <div className={styles.noPrint}>
        <SiteHeader />
      </div>
      <main className={`${styles.wrap} ${styles.section}`}>
        {q.isPending ? (
          <p className={styles.muted}>…</p>
        ) : q.error || !d ? (
          <section className={styles.contactCard}>
            <h1>{t("notFound")}</h1>
            <Link className="button button-primary" href="/contact-sales">
              {t("contact")}
            </Link>
          </section>
        ) : (
          <div className={styles.contactGrid}>
            <article className={styles.contactCard} aria-label={t("title", { number: d.number })}>
              <span className={styles.muted}>{t("from")}</span>
              <h1>{t("title", { number: d.number })}</h1>
              <p>{t("to", { company: d.company })}</p>
              <table className={styles.quoteTable}>
                <tbody>
                  <tr>
                    <td>
                      {t("item", { months: d.months })}
                      <div className={styles.muted}>
                        {t("qty", { seats: f.number(d.seats), months: d.months })} · {t("perSeat", { price: money(d.pricePerSeatSatang) })}
                      </div>
                    </td>
                    <td className={styles.num}>{money(d.subtotalSatang)}</td>
                  </tr>
                  <tr>
                    <td>{t("vat")}</td>
                    <td className={styles.num}>{money(d.vatSatang)}</td>
                  </tr>
                  <tr>
                    <th>{t("total")}</th>
                    <th className={styles.num}>{money(d.totalSatang)}</th>
                  </tr>
                </tbody>
              </table>
              {ents.length > 0 && (
                <p className={styles.small}>
                  <b>{t("includes")}:</b> {ents.join(" · ")}
                </p>
              )}
              <p className={styles.small}>
                {d.contractStart && <>{t("start", { date: date(d.contractStart) })} · </>}
                {t("until", { date: date(d.validUntil) })}
              </p>
              <div className={styles.noPrint}>
                <Button onClick={() => window.print()}>{t("print")}</Button>
              </div>
            </article>
            <div className={`${styles.stackLg} ${styles.noPrint}`}>
              {d.status === "accepted" ? (
                <section className={styles.contactCard} aria-live="polite">
                  <h2>{t("accepted")}</h2>
                  <p className={styles.muted}>{t("acceptedLead", { name: d.acceptedBy ?? "" })}</p>
                </section>
              ) : d.status !== "sent" ? (
                <section className={styles.contactCard}>
                  <h2>{t("expired")}</h2>
                  <Link className="button button-primary" href="/contact-sales">
                    {t("contact")}
                  </Link>
                </section>
              ) : (
                <>
                  <form className={styles.contactCard} onSubmit={(e) => (e.preventDefault(), name.trim().length >= 2 && title.trim().length >= 2 && agree && !accept.isPending && accept.mutate())}>
                    <h2>{t("acceptTitle")}</h2>
                    <Input label={t("signer")} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
                    <Input label={t("signerTitle")} value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="organization-title" />
                    <Input label={t("po")} value={po} onChange={(e) => setPo(e.target.value)} />
                    <label className={styles.consent}>
                      <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                      <span>{t("agree")}</span>
                    </label>
                    {accept.error && (
                      <p className="field-error" role="alert">
                        {(accept.error as Error).message}
                      </p>
                    )}
                    <Button type="submit" variant="primary" disabled={name.trim().length < 2 || title.trim().length < 2 || !agree || accept.isPending}>
                      {accept.isPending ? t("accepting") : t("accept")}
                    </Button>
                  </form>
                  <form className={styles.contactCard} onSubmit={(e) => (e.preventDefault(), message.trim().length >= 5 && !change.isPending && change.mutate())}>
                    <h2>{t("changeTitle")}</h2>
                    {change.isSuccess ? (
                      <p className={styles.muted}>{t("changeSent")}</p>
                    ) : (
                      <>
                        <div className="field">
                          <label htmlFor="q-change">{t("changeHint")}</label>
                          <textarea id="q-change" className="input" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
                        </div>
                        <Input label={t("changeEmail")} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                        {change.error && (
                          <p className="field-error" role="alert">
                            {(change.error as Error).message}
                          </p>
                        )}
                        <Button type="submit" disabled={message.trim().length < 5 || change.isPending}>
                          {t("changeSend")}
                        </Button>
                      </>
                    )}
                  </form>
                </>
              )}
            </div>
          </div>
        )}
      </main>
      <div className={styles.noPrint}>
        <SiteFooter />
      </div>
    </div>
  );
}
