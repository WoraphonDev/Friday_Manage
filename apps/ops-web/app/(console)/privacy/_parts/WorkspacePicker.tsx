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

/**
 * เลือก Workspace หลายแห่งด้วยการค้นหา (A3 · A4)
 * `extra` = รายการที่ค้นจาก GET workspaces ไม่เจอ (เช่น Workspace ที่รอลบ สำหรับตั้ง Legal hold · H11) กรองด้วยคำค้นเดียวกัน
 */
export function WorkspacePicker({ label, placeholder, hint, value, onChange, extra = [] }: { label: string; placeholder: string; hint?: string; value: PickedWs[]; onChange: (v: PickedWs[]) => void; extra?: PickedWs[] }) {
  const [q, setQ] = useState("");
  const search = useDeferredValue(q.trim());
  const found = useQuery({
    queryKey: ["ops", "workspaces", "pick", search],
    queryFn: () => api.get<{ items: PickedWs[] }>(`/workspaces?q=${encodeURIComponent(search)}&limit=6`),
    enabled: search.length >= 2,
  });
  const needle = search.toLowerCase();
  const more = search.length >= 2 ? extra.filter((w) => w.name.toLowerCase().includes(needle) || w.slug.toLowerCase().includes(needle)) : [];
  const options = [...(found.data?.items ?? []), ...more].filter((w, i, all) => !value.some((v) => v.id === w.id) && all.findIndex((x) => x.id === w.id) === i);
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
