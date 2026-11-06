import { EnrollPage } from "@/features/auth/EnrollForm";

// โทเค็นมาจากลิงก์ที่ Admin ส่งให้ (`/enroll?token=...`) หรือพิมพ์เอง
export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const { token } = await searchParams;
  return <EnrollPage token={typeof token === "string" ? token : undefined} />;
}
