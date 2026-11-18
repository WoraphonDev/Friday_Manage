"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";

/** กำลังดูโดย (ช่วง 2) · ops-api › presence */
export type PresenceType = "ticket" | "payment" | "approval" | "privacy";
export interface Seen {
  id: string;
  staffId: string;
  name: string;
  mode: "viewing" | "typing";
}
const BEAT = 15_000;

/**
 * ส่งสัญญาณว่ากำลังเปิด / พิมพ์อยู่ทุก 15 วินาที · เปลี่ยนโหมดส่งทันที · ปิดแล้วส่ง leave
 * คืนรายชื่อเพื่อนที่อยู่ที่รายการเดียวกัน
 */
export function usePresence(type: PresenceType, id: string | null, mode: "viewing" | "typing" = "viewing") {
  const [others, setOthers] = useState<Seen[]>([]);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    if (!id) return;
    let alive = true;
    const ping = () =>
      api
        .post<{ others: Seen[] }>("/presence", { type, id, mode: modeRef.current })
        .then((r) => alive && setOthers(r.others))
        .catch(() => undefined);
    void ping();
    const timer = setInterval(ping, BEAT);
    return () => {
      alive = false;
      clearInterval(timer);
      setOthers([]);
      void api.post("/presence/leave", { type, id }).catch(() => undefined);
    };
  }, [type, id]);
  // เริ่ม / หยุดพิมพ์ = บอกเพื่อนทันที ไม่รอรอบถัดไป
  useEffect(() => {
    if (!id) return;
    void api
      .post<{ others: Seen[] }>("/presence", { type, id, mode })
      .then((r) => setOthers(r.others))
      .catch(() => undefined);
  }, [type, id, mode]);
  return others;
}

/** เพื่อนที่อยู่ที่รายการในตาราง (ทุก 15 วินาที) · คืน Map ตามรหัส */
export function usePresenceOf(type: PresenceType, ids: string[]) {
  const key = ids.join(",");
  const q = useQuery({
    queryKey: ["ops", "presence", type, key],
    queryFn: () => api.get<{ items: Seen[] }>(`/presence?type=${type}&ids=${key}`),
    enabled: ids.length > 0,
    refetchInterval: BEAT,
    staleTime: BEAT,
  });
  const map = new Map<string, Seen[]>();
  for (const s of q.data?.items ?? []) map.set(s.id, [...(map.get(s.id) ?? []), s]);
  return map;
}
