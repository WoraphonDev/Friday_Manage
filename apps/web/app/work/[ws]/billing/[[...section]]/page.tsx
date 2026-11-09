import { Billing } from "../_components/billing";

export default async function Page({ params }: { params: Promise<{ ws: string; section?: string[] }> }) {
  const { ws, section } = await params;
  // /billing/a/b ไม่มีหน้า · ส่งค่าที่ไม่รู้จักให้ component แสดง NotFound (/billing/checkout มีหน้าของตัวเอง)
  return <Billing ws={ws} section={section?.join("/")} />;
}
