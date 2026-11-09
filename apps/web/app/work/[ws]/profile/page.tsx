import { ProfilePage } from "./_components/profile-page";

export default async function Page({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  return <ProfilePage ws={ws} />;
}
