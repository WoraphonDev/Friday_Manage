import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { JoinInvite } from "./_components/join-invite";

// ชื่อแท็บตามภาษาของคำขอ (W21)
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.auth");
  return { title: t("join") };
}

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <JoinInvite token={token} />;
}
