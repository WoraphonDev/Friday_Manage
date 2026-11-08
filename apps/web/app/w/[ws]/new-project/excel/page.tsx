import { CreateFromExcel } from "./create-from-excel";

export default async function Page({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  return <CreateFromExcel ws={ws} />;
}
