import { InboxPage } from "./_components/inbox-page";

export default async function Page({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  return <InboxPage ws={ws} />;
}
