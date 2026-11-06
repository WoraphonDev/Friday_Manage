import { FilesPage } from "./_components/files-page";

export default async function Page({ params }: { params: Promise<{ ws: string; key: string }> }) {
  const { ws, key } = await params;
  return <FilesPage ws={ws} projectKey={key} />;
}
