"use client";

import { useTranslations } from "next-intl";
import { BusinessSubPage, Features, Upgrade } from "../BusinessPage";

/** เมนู "การใช้ฟีเจอร์" · หน้าของตัวเองแทนลิงก์ # ในหน้าธุรกิจ */
export default function Page() {
  const t = useTranslations("common.nav");
  const tb = useTranslations("ob.biz");
  return (
    <BusinessSubPage title={t("adoption")} desc={tb("adoptionDesc")}>
      {(b) => (
        <>
          <Features b={b} />
          <Upgrade b={b} />
        </>
      )}
    </BusinessSubPage>
  );
}
