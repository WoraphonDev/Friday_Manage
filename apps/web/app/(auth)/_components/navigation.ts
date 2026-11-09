import { api } from "@/lib/api";

interface WorkspaceItem {
  slug: string;
}

/** หลังเข้าสู่ระบบ: กลับหน้าเดิม → Workspace แรก → ยังไม่มี Workspace ไป Onboarding (J5) */
export async function destinationAfterLogin(returnTo: string | null) {
  if (returnTo) return returnTo;
  const { items } = await api.get<{ items: WorkspaceItem[] }>("/me/workspaces");
  return items[0] ? `/work/${items[0].slug}` : "/onboarding";
}
