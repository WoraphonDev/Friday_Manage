import type { Metadata } from "next";
import { QuotePage } from "../../_components/quote";

// ลิงก์ส่วนตัวของลูกค้า · ไม่ให้เครื่องมือค้นหาเก็บ
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <QuotePage token={token} />;
}
