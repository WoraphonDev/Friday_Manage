"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { hasAny } from "@/components/access";
import { Empty, ErrorBlock, NoAccess, PageHead, TableSkeleton } from "@/components/kit";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useFmt } from "../workspaces/_parts/format";
import { BreachDrawer, BreachesCard, NewBreach } from "./_parts/Breaches";
import { CreateRequest, RequestDrawer, RequestStats, RequestsTable, useRequests } from "./_parts/Requests";

const RETENTION = ["ws", "trash", "activity", "logs", "tax", "staff"] as const;

/**
 * หน้า 10 · คำขอ PDPA และการเก็บข้อมูล (Privacy.dc.html · A3–A6)
 * คำขอ: Owner / Support ทำ · ผู้ตรวจอ่าน · เหตุละเมิด: Owner / วิศวกร ทำ · ผู้ตรวจอ่าน · ops-api ตรวจสิทธิ์ซ้ำ
 */
export function PrivacyPage() {
  const t = useTranslations("pl.privacy");
  const me = useMe().data;
  const params = useSearchParams();
  const router = useRouter();
  const readRequests = hasAny(me, "owner", "support", "auditor");
  const actRequests = hasAny(me, "owner", "support");
  const readBreaches = hasAny(me, "owner", "engineer", "auditor");
  const editBreaches = hasAny(me, "owner", "engineer");
  const owner = hasAny(me, "owner");
  const requests = useRequests(!!me && readRequests);
  const [creating, setCreating] = useState<"request" | "breach" | null>(null);
  const open = (kind: "request" | "breach", id: string | null) => router.replace(id ? `/privacy?${kind}=${id}` : "/privacy");
  const reqId = params?.get("request") ?? null;
  const breachId = params?.get("breach") ?? null;
  if (me && !readRequests && !readBreaches) return <NoAccess need={["owner", "support", "engineer", "auditor"]} />;
  return (
    <>
      <PageHead
        title={t("title")}
        desc={t("desc")}
        actions={
          <>
            {actRequests && (
              <Button onClick={() => setCreating("request")}>
                <Plus size={16} /> {t("create")}
              </Button>
            )}
            {editBreaches && (
              <Button variant="danger" onClick={() => setCreating("breach")}>
                <ShieldAlert size={16} /> {t("breach")}
              </Button>
            )}
          </>
        }
      />
      {readRequests && (requests.data ? <RequestStats items={requests.data.items} /> : null)}
      {readRequests && <RequestsTable query={requests} onOpen={(id) => open("request", id)} />}
      {readBreaches && <BreachesCard onOpen={(id) => open("breach", id)} />}
      {readRequests && (
        <div className="grid-2">
          <PendingDeletes />
          <Retention />
        </div>
      )}
      {reqId && readRequests && <RequestDrawer id={reqId} canAct={actRequests} onClose={() => open("request", null)} />}
      {breachId && readBreaches && <BreachDrawer id={breachId} canEdit={editBreaches} isOwner={owner} onClose={() => open("breach", null)} />}
      {creating === "request" && <CreateRequest onClose={() => setCreating(null)} onCreated={(id) => (setCreating(null), open("request", id))} />}
      {creating === "breach" && <NewBreach onClose={() => setCreating(null)} onCreated={(id) => (setCreating(null), open("breach", id))} />}
    </>
  );
}

interface PendingDelete {
  id: string;
  slug: string;
  name: string;
  requestedAt: string;
  purgeAt: string;
  requestedBy: string | null;
}
/** Workspace ที่รอลบ (ระยะผ่อนผัน 30 วัน) */
function PendingDeletes() {
  const t = useTranslations("pl.privacy");
  const fmt = useFmt();
  const q = useQuery({ queryKey: ["ops", "privacy", "pending-deletes"], queryFn: () => api.get<{ items: PendingDelete[] }>("/privacy/pending-deletes") });
  return (
    <section className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div className="card-head" style={{ padding: "14px 16px", margin: 0, borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
        <h2 className="card-title">{t("pendingDeletes")}</h2>
        <span className="card-sub">{t("pendingDeletesSub")}</span>
      </div>
      {q.isPending ? (
        <TableSkeleton rows={2} cols={4} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !q.data.items.length ? (
        <Empty ok title={t("noPendingDeletes")} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("pdCol.ws")}</th>
                <th>{t("pdCol.by")}</th>
                <th>{t("pdCol.purge")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((d) => {
                const days = Math.ceil((Date.parse(d.purgeAt) - Date.now()) / 86_400_000);
                return (
                  <tr key={d.id}>
                    <td>{d.name}</td>
                    <td className="small">
                      {d.requestedBy ?? "—"} · {fmt.date(d.requestedAt)}
                    </td>
                    <td>
                      <span className={days <= 7 ? "pill warn" : "pill"}>{days > 0 ? t("purgeIn", { n: days }) : t("purgeDue")}</span>
                    </td>
                    <td>
                      <Link className="link-button small" href={`/workspaces/${d.id}`}>
                        {t("open")}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** นโยบายการเก็บข้อมูล (ตามสเปก · ข้อความคงที่) */
function Retention() {
  const t = useTranslations("pl.privacy");
  return (
    <section className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div className="card-head" style={{ padding: "14px 16px", margin: 0, borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
        <h2 className="card-title">{t("retention")}</h2>
        <span className="card-sub">{t("retentionSub")}</span>
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t("rCol.what")}</th>
              <th>{t("rCol.keep")}</th>
              <th>{t("rCol.why")}</th>
            </tr>
          </thead>
          <tbody>
            {RETENTION.map((k) => (
              <tr key={k}>
                <td>{t(`retentionRows.${k}.what`)}</td>
                <td className="num">{t(`retentionRows.${k}.keep`)}</td>
                <td className="small muted">{t(`retentionRows.${k}.why`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
