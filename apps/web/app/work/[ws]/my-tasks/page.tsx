import { MyTasksPage } from "./_components/my-tasks-page";

export default async function Page({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  return <MyTasksPage ws={ws} />;
}
