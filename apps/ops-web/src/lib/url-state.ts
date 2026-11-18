"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useRef, useState } from "react";

/**
 * ตัวกรองของหน้ารายการเก็บใน URL (ช่วง 1 · ออกแบบสำหรับข้อมูลเยอะ): กดย้อนกลับจากหน้ารายละเอียดแล้วยังอยู่ที่เดิม และส่งลิงก์ให้เพื่อนได้
 * เขียนเฉพาะค่าที่ต่างจากค่าเริ่มต้น · พารามิเตอร์อื่นของหน้า (เช่น ?ticket=) คงไว้
 * state ในหน้าเป็นตัวหลัก URL เป็นสำเนา จึงไม่รอ router ก่อนแสดงผล
 */
export function useUrlFilters<T extends Record<string, string>>(defaults: T) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<T>(() => {
    const init = { ...defaults };
    for (const k of Object.keys(defaults) as (keyof T & string)[]) {
      const v = params?.get(k);
      if (v != null) init[k] = v as T[typeof k];
    }
    return init;
  });
  const current = useRef(state);
  const set = useCallback(
    (patch: Partial<T>) => {
      const next = { ...current.current, ...patch };
      current.current = next;
      setState(next);
      const q = new URLSearchParams();
      params?.forEach((v, k) => {
        if (!(k in defaults)) q.set(k, v);
      });
      for (const k of Object.keys(next)) if (next[k] !== "" && next[k] !== defaults[k]) q.set(k, next[k]);
      const s = q.toString();
      router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
    },
    // defaults เป็นค่าคงที่ของหน้า
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params, pathname, router],
  );
  return [state, set] as const;
}
