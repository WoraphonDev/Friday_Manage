"use client";

import { useWorkspace } from "@/components/shell/workspace-shell";
import { KanbanBoard } from "./kanban-board";

export function KanbanPage({ ws, projectKey }: { ws: string; projectKey: string }) {
  const { me } = useWorkspace();
  return <KanbanBoard ws={ws} projectKey={projectKey} yearFormat={me.yearFormat} />;
}
