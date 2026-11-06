import { Billing } from "../_components/billing";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ ws: string; section?: string[] }>;
  searchParams: Promise<{ plan?: string | string[]; cycle?: string | string[] }>;
}) {
  const { ws, section } = await params;
  const query = await searchParams;
  const one = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v);
  // /billing/a/b ไม่มีหน้า · ส่งค่าที่ไม่รู้จักให้ component แสดง NotFound
  return <Billing ws={ws} section={section?.join("/")} plan={one(query.plan)} cycle={one(query.cycle)} />;
}
