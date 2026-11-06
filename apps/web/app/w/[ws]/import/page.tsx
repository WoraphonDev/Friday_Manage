import { ImportWizard } from "./_components/import-wizard";

export default async function Page({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  return <ImportWizard ws={ws} />;
}
