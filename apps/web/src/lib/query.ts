import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

export const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30000,
        retry: (count, error) =>
          count < 1 && (!(error instanceof ApiError) || error.status >= 500),
        refetchOnWindowFocus: false,
      },
    },
  });

export const queryKeys = {
  me: ["me"] as const,
  workspaces: ["me", "workspaces"] as const,
  notifications: ["me", "notifications", "summary"] as const,
  projects: (ws: string) => ["workspace", ws, "projects"] as const,
  project: (ws: string, key: string) =>
    ["workspace", ws, "project", key] as const,
  permissions: (ws: string, key: string) =>
    ["workspace", ws, "project", key, "permissions"] as const,
};
