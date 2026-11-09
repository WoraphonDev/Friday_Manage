"use client";

import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { Input } from "@/components/ui";
import { api } from "@/lib/api";

export interface PickedWs {
  id: string;
  name: string;
  slug: string;
}

/** เลือก Workspace หลายแห่งด้วยการค้นหา (A3 · A4) */
export function WorkspacePicker({ label, placeholder, hint, value, onChange }: { label: string; placeholder: string; hint?: string; value: PickedWs[]; onChange: (v: PickedWs[]) => void }) {
  const [q, setQ] = useState("");
  const search = useDeferredValue(q.trim());
  const found = useQuery({
    queryKey: ["ops", "workspaces", "pick", search],
    queryFn: () => api.get<{ items: PickedWs[] }>(`/workspaces?q=${encodeURIComponent(search)}&limit=6`),
    enabled: search.length >= 2,
  });
  const options = (found.data?.items ?? []).filter((w) => !value.some((v) => v.id === w.id));
  return (
    <div className="field">
      <Input label={label} placeholder={placeholder} hint={hint} value={q} onChange={(e) => setQ(e.target.value)} />
      {options.length > 0 && (
        <div className="row" role="listbox" aria-label={label}>
          {options.map((w) => (
            <button key={w.id} type="button" role="option" aria-selected={false} className="chip" onClick={() => (onChange([...value, w]), setQ(""))}>
              {w.name}
            </button>
          ))}
        </div>
      )}
      {value.length > 0 && (
        <div className="row">
          {value.map((w) => (
            <span key={w.id} className="pill inf">
              {w.name}
              <button type="button" className="link-button" aria-label={`ลบ ${w.name}`} onClick={() => onChange(value.filter((x) => x.id !== w.id))}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
