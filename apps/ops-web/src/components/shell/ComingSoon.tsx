"use client";

import { Map } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { buttonClass } from "../ui";

/** เมนูเฟส 2–3 และหน้าเฟส 1 ที่ยังไม่เปิด (ComingSoon.dc.html) */
export function ComingSoon() {
  const t = useTranslations("common");
  const key = useSearchParams()?.get("f");
  const feature = key && t.has(`nav.${key}` as "nav.home") ? t(`nav.${key}` as "nav.home") : t("nav.roadmap");
  return (
    <section className="card state">
      <span className="state-icon" aria-hidden="true">
        <Map size={20} />
      </span>
      <h1 className="page-title">{t("soon.title")}</h1>
      <p className="muted">{t("soon.desc", { feature })}</p>
      <Link href="/" className={buttonClass("primary")}>
        {t("soon.back")}
      </Link>
    </section>
  );
}
