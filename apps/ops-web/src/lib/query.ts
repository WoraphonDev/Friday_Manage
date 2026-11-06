import { QueryClient, useQuery } from "@tanstack/react-query";
import { api, ApiError } from "./api";
import type { Staff } from "./types";

export const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30000,
        retry: (count, error) => count < 1 && (!(error instanceof ApiError) || error.status >= 500),
        refetchOnWindowFocus: false,
      },
    },
  });

export const keys = {
  me: ["ops", "me"] as const,
  metrics: ["ops", "metrics"] as const,
  workspaces: (filter: Record<string, string>) => ["ops", "workspaces", filter] as const,
  workspace: (id: string) => ["ops", "workspace", id] as const,
  sessions: ["ops", "support-sessions"] as const,
  payments: (status: string) => ["ops", "payments", status] as const,
  flags: ["ops", "feature-flags"] as const,
  announcements: ["ops", "announcements"] as const,
};

/** พนักงานที่ล็อกอินอยู่ (ops/auth/me) · ใช้ซ่อนปุ่มตามบทบาท */
export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: () => api.get<{ staff: Staff }>("/auth/me").then((r) => r.staff), staleTime: 300000 });
}
