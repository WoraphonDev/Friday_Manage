import { AccountDetail } from "./AccountDetail";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AccountDetail id={id} />;
}
