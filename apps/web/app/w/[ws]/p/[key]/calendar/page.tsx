import { CalendarView } from "./_components/calendar-view";

export default async function Page({ params }: { params: Promise<{ ws: string; key: string }> }) {
  const { ws, key } = await params;
  return <CalendarView ws={ws} projectKey={key} />;
}
