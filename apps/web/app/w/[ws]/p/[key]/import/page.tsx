import { ProjectImport } from "./_components/project-import";

export default async function Page({ params }: { params: Promise<{ ws: string; key: string }> }) {
  const { ws, key } = await params;
  return <ProjectImport ws={ws} projectKey={key} />;
}
