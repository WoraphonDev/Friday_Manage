import { hasAny } from "@/components/access";

type Me = Parameters<typeof hasAny>[0];
/** อ่านได้: Owner / Support / การเงิน / ผู้ตรวจ · วิศวกรไม่เห็น (06-ops-roles) · ops-api ตรวจซ้ำเสมอ */
export const canRead = (me: Me) => hasAny(me, "owner", "support", "finance", "auditor");
/** ติดตามและส่งอีเมล: Owner / Support */
export const canFollow = (me: Me) => hasAny(me, "owner", "support");
