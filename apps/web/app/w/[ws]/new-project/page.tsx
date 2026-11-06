import { NewProjectWizard } from "./_components/new-project-wizard";

export default async function Page({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  return <NewProjectWizard ws={ws} />;
}
