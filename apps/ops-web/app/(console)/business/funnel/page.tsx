"use client";

import { useTranslations } from "next-intl";
import { BusinessSubPage, Channels, Cohorts, Funnel, Reasons } from "../BusinessPage";

/** เมนู "Funnel และ Retention" · หน้าของตัวเองแทนลิงก์ # ในหน้าธุรกิจ */
export default function Page() {
  const t = useTranslations("common.nav");
  const tb = useTranslations("ob.biz");
  return (
    <BusinessSubPage title={t("funnel")} desc={tb("funnelDesc")}>
      {(b) => (
        <>
          <div className="grid-2">
            <Funnel b={b} />
            <Cohorts b={b} />
          </div>
          <Channels b={b} />
          <Reasons b={b} />
        </>
      )}
    </BusinessSubPage>
  );
}
