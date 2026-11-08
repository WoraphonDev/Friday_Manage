"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Copy } from "lucide-react";
import { Button, Dialog, ErrorState, Input, LoadingState, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import styles from "./cal.module.css";

interface Feed { id: string; projectKey: string | null; createdAt: string }

/** ลิงก์ iCal ส่วนตัว (A21) · API เก็บแค่ hash จึงเห็น URL ได้ครั้งเดียวตอนสร้าง · สร้างใหม่ = เพิกถอนอันเดิมของโปรเจกต์นี้ */
export function SubscribeDialog({ ws, projectKey, onClose }: { ws: string; projectKey: string; onClose: () => void }) {
  const t = useTranslations("calendar.subscribe");
  const { me } = useWorkspace();
  const toast = useToast();
  const cache = useQueryClient();
  const key = ["calendar-feeds", ws];
  const feeds = useQuery({ queryKey: key, queryFn: () => api.get<{ items: Feed[] }>(`/me/calendar-feeds?workspace=${encodeURIComponent(ws)}`) });
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const mine = (feeds.data?.items ?? []).filter((f) => f.projectKey?.toUpperCase() === projectKey.toUpperCase());

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      await cache.invalidateQueries({ queryKey: key });
    }
  }
  const create = () =>
    run(async () => {
      const old = mine.map((f) => f.id);
      const res = await api.post<{ url: string }>("/me/calendar-feeds", { workspace: ws, projectKey });
      setUrl(res.url);
      for (const id of old) await api.delete(`/me/calendar-feeds/${encodeURIComponent(id)}`);
    });
  const revoke = (id: string) =>
    run(async () => {
      await api.delete(`/me/calendar-feeds/${encodeURIComponent(id)}`);
      toast({ message: t("revoked") });
    });
  async function copy() {
    try {
      await navigator.clipboard.writeText(url!);
      toast({ message: t("copied") });
    } catch {
      toast({ message: t("copyFailed") });
    }
  }
  const google = url ? `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(url.replace(/^https?:/, "webcal:"))}` : null;

  return (
    <Dialog open title={t("title")} description={t("description")} onOpenChange={(o) => { if (!o) onClose(); }}>
      <div className={styles.form}>
        {url && (
          <>
            <div className={styles.copyRow}>
              <Input label={t("url")} readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
              <Button onClick={copy}><Copy size={16} />{t("copy")}</Button>
            </div>
            <p className={styles.warn}>{t("secret")}</p>
            <a href={google!} target="_blank" rel="noopener noreferrer">{t("google")}</a>
          </>
        )}
        {feeds.isPending ? <LoadingState /> : feeds.error ? <ErrorState error={feeds.error} retry={() => feeds.refetch()} /> : (
          <div>
            <h3 className={styles.sub}>{t("existing")}</h3>
            {mine.length === 0 ? <p className="muted">{t("none")}</p> : (
              <ul className={styles.feeds}>
                {mine.map((f) => (
                  <li key={f.id}>
                    <span>{t("createdAt", { date: formatDate(f.createdAt, me.yearFormat) })}</span>
                    <Button size="small" variant="ghost" disabled={busy} onClick={() => revoke(f.id)}>{t("revoke")}</Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {!!error && <ErrorState error={error} />}
        <div className={styles.actions}>
          {mine.length > 0 && !url && <span className="muted" style={{ fontSize: 11, marginRight: "auto" }}>{t("regenerateHint")}</span>}
          <Button variant="primary" disabled={busy || feeds.isPending} onClick={create}>{mine.length > 0 ? t("regenerate") : t("create")}</Button>
        </div>
      </div>
    </Dialog>
  );
}
