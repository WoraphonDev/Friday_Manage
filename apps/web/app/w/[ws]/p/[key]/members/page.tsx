import { MembersView } from "./_components/members-view";

export default async function Page({ params }: { params: Promise<{ ws: string; key: string }> }) {
  const { ws, key } = await params;
  return <MembersView ws={ws} projectKey={key} />;
}
