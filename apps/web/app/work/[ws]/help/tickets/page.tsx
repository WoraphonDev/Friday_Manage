import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { TicketsRoute } from "../_components/routes";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("help.tickets");
  return { title: t("title") };
}

/** X6 · Ticket ของฉัน (T12 สถานะส่งทีมพัฒนา / แก้แล้ว) */
export default function Page() {
  return <TicketsRoute />;
}
