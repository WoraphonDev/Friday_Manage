"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { NoAccess } from "@/components/kit";
import { LoadingState } from "@/components/ui";
import { rolesOf } from "@/components/access";
import { useMe } from "@/lib/query";
import { useMobileTabs } from "./_parts/MobileFrame";

/** /m → แท็บแรกที่บทบาทนี้ใช้ได้ */
export default function MobileHome() {
  const me = useMe().data;
  const tabs = useMobileTabs();
  const router = useRouter();
  useEffect(() => {
    if (me && tabs[0]) router.replace(tabs[0].href);
  }, [me, tabs[0]?.href, router]); // eslint-disable-line react-hooks/exhaustive-deps
  if (me && !tabs.length) return <NoAccess need={["owner", "finance", "engineer", "support"]} mine={rolesOf(me)} />;
  return <LoadingState />;
}
