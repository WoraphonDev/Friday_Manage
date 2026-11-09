import { Checkout } from "@/features/checkout/Checkout";

/** W22 · /work/:ws/billing/checkout?plan=&cycle= (ชำระเงินแพ็กเกจ) */
export default async function Page({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ plan?: string | string[]; cycle?: string | string[] }> }) {
  const { ws } = await params;
  const query = await searchParams;
  const one = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v);
  return <Checkout ws={ws} initialPlan={one(query.plan)} initialCycle={one(query.cycle)} />;
}
