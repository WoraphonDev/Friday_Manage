"use client";

import { useTranslations } from "next-intl";
import { hasAny } from "@/components/access";
import { NoAccess, PageHead } from "@/components/kit";
import { useMe } from "@/lib/query";
import { Sessions } from "../SupportPage";

/** เมนู "การเข้าช่วยเหลือ" · ใครอยู่ในบัญชีลูกค้าตอนนี้ และจบการเข้าช่วยเหลือได้ (หน้าของตัวเองแทนลิงก์ #) */
export default function Page() {
  const t = useTranslations("common.nav");
  const ts = useTranslations("ss.support");
  const me = useMe().data;
  if (me && !hasAny(me, "owner", "support")) return <NoAccess need={["owner", "support"]} />;
  return (
    <>
      <PageHead title={t("sessions")} desc={ts("sessionsDesc")} />
      <Sessions />
    </>
  );
}
