"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Megaphone, X } from "lucide-react";
import { Button, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import styles from "./announcements.module.css";

export interface Announcement {
  id: string;
  title: string;
  message: string;
  sentAt: string;
}
type Role = "owner" | "admin" | "member" | "guest";

/** ข้อความยาวกว่านี้ย่อไว้ก่อน กดอ่านต่อได้ (แบนเนอร์ไม่ควรดันเนื้อหาหน้าลงไปมาก) */
const LONG = 160;
const key = (ws: string) => ["announcements", ws] as const;

/**
 * แบนเนอร์ประกาศจากทีม Friday (O24 · ส่งจาก Friday Ops › C8) ใต้แถบบนของ WorkspaceShell
 * ส่งถึง Owner / Admin เท่านั้น จึงไม่เรียก API สำหรับสมาชิกอื่น · ปิดแล้วไม่ขึ้นอีกเฉพาะคนที่ปิด (`w/{ws}/announcements/{id}/dismiss`)
 */
export function AnnouncementBanners({ ws, role }: { ws: string; role: Role }) {
  const t = useTranslations("announcements");
  const toast = useToast();
  const cache = useQueryClient();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const enabled = role === "owner" || role === "admin";
  const q = useQuery({
    queryKey: key(ws),
    queryFn: () => api.get<{ items: Announcement[] }>(`/w/${encodeURIComponent(ws)}/announcements`),
    enabled,
    retry: false,
    staleTime: 300_000,
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => api.post(`/w/${encodeURIComponent(ws)}/announcements/${id}/dismiss`),
    // ซ่อนทันทีที่กด · ล้มเหลวค่อยคืนกลับ
    onMutate: (id) => {
      const before = cache.getQueryData<{ items: Announcement[] }>(key(ws));
      cache.setQueryData<{ items: Announcement[] }>(key(ws), (d) => (d ? { items: d.items.filter((a) => a.id !== id) } : d));
      return { before };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.before) cache.setQueryData(key(ws), ctx.before);
      toast({ message: t("dismissFailed"), tone: "error" });
    },
  });
  const items = enabled ? (q.data?.items ?? []) : [];
  if (!items.length) return null;
  return (
    <section className={styles.stack} aria-label={t("region")}>
      {items.map((a) => {
        const long = a.message.length > LONG;
        const expanded = !!open[a.id];
        return (
          <div key={a.id} className={styles.banner} role="status">
            <span className={styles.icon} aria-hidden="true">
              <Megaphone size={16} />
            </span>
            <div className={styles.body}>
              <span className={styles.label}>{t("label")}</span>
              <b className={styles.title}>{a.title}</b>
              <p className={styles.message}>{long && !expanded ? `${a.message.slice(0, LONG).trimEnd()}…` : a.message}</p>
              {long && (
                <button type="button" className={styles.more} aria-expanded={expanded} onClick={() => setOpen((o) => ({ ...o, [a.id]: !expanded }))}>
                  {expanded ? t("less") : t("more")}
                </button>
              )}
            </div>
            <Button variant="ghost" size="icon" className={styles.close} aria-label={t("dismiss", { title: a.title })} disabled={dismiss.isPending && dismiss.variables === a.id} onClick={() => dismiss.mutate(a.id)}>
              <X size={16} />
            </Button>
          </div>
        );
      })}
    </section>
  );
}
