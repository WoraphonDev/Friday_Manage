import { HomePage } from "./my-tasks/_components/home-page";

export default async function Page({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  return <HomePage ws={ws} />;
}
