"use client";

import { Plus, ShieldAlert } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { hasAny } from "@/components/access";
import { NoAccess, PageHead } from "@/components/kit";
import { Button } from "@/components/ui";
import { useMe } from "@/lib/query";
import { BreachDrawer, BreachesCard, NewBreach } from "./_parts/Breaches";
import { Lifecycle, LifecycleKpis } from "./_parts/Lifecycle";
import { CreateRequest, RequestDrawer, RequestsTable, useRequests } from "./_parts/Requests";

/**
 * หน้า 10 · คำขอ PDPA และการเก็บข้อมูล (Privacy.dc.html · A3–A6 · รอบ 4 H10–H13)
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
      {readRequests && requests.data && <LifecycleKpis requests={requests.data.items} />}
      {readRequests && <RequestsTable query={requests} onOpen={(id) => open("request", id)} />}
      {readBreaches && <BreachesCard onOpen={(id) => open("breach", id)} />}
      {/* ส่วนล่าง (H10): Workspace ที่รอลบ · Legal hold · นโยบายการเก็บข้อมูล · Owner แก้ / คนอื่นอ่าน */}
      {readRequests && <Lifecycle owner={owner} />}
      {reqId && readRequests && <RequestDrawer id={reqId} canAct={actRequests} onClose={() => open("request", null)} />}
      {breachId && readBreaches && <BreachDrawer id={breachId} canEdit={editBreaches} isOwner={owner} onClose={() => open("breach", null)} />}
      {creating === "request" && <CreateRequest onClose={() => setCreating(null)} onCreated={(id) => (setCreating(null), open("request", id))} />}
      {creating === "breach" && <NewBreach onClose={() => setCreating(null)} onCreated={(id) => (setCreating(null), open("breach", id))} />}
    </>
  );
}
