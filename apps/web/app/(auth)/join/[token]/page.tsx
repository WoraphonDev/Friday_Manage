import type { Metadata } from "next";
import common from "../../../../messages/th/common.json";
import { JoinInvite } from "./_components/join-invite";

export const metadata: Metadata = { title: common.auth.join };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <JoinInvite token={token} />;
}
