import { InvoicePay } from "@/features/checkout/InvoicePay";

/** W22b · /work/:ws/billing/invoices/:id?slip=new (ชำระใบแจ้งหนี้แบบโอน · แนบสลิป) */
export default async function Page({ params, searchParams }: { params: Promise<{ ws: string; id: string }>; searchParams: Promise<{ slip?: string | string[] }> }) {
  const { ws, id } = await params;
  const { slip } = await searchParams;
  return <InvoicePay ws={ws} id={id} replace={slip === "new"} />;
}
