"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Workflow } from "lucide-react";
import { api } from "@/lib/api";
import type { DiagramList } from "./types";
import styles from "./diagrams.module.css";

/**
 * บรรทัด "Diagram" ในแผงรายละเอียดงาน: Diagram ที่มีกล่องผูกกับงานนี้ (storyboard แท็บ Diagram)
 * ไม่มี / แพ็กเกจ Free / ไม่มีสิทธิ์ = ไม่แสดงอะไร จึงไม่ต้องมีข้อความว่าง
 */
export function IssueDiagrams({ ws, projectKey, issueId, render }: { ws: string; projectKey: string; issueId: string; render: (links: React.ReactNode) => React.ReactNode }) {
  const base = `/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projectKey)}`;
  const list = useQuery({
    queryKey: ["diagrams", ws, projectKey, "issue", issueId],
    queryFn: () => api.get<DiagramList>(`${base}/diagrams?${new URLSearchParams({ issue: issueId })}`, { planDialog: false }),
    retry: false,
    staleTime: 30_000,
  });
  const items = list.data?.items ?? [];
  if (!items.length) return null;
  const href = `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/diagrams`;
  return render(
    <span className={styles.issueDiagrams}>
      {items.map((d) => (
        <Link key={d.id} href={`${href}/${d.id}`} className={styles.issueDiagram}>
          <Workflow size={13} aria-hidden="true" />
          {d.name}
        </Link>
      ))}
    </span>,
  );
}
