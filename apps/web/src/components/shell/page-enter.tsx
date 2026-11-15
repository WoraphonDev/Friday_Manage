"use client";
import { useEffect, useState, type ReactNode } from "react";

/** ช่วงที่แถวและการ์ดที่เพิ่งขึ้นจะโผล่ไล่กัน · แถวที่ขึ้นหลังจากนี้ (สร้างงานใหม่ ลากการ์ด) ไม่ขยับซ้ำ */
const ENTERING_MS = 2000;

/**
 * กรอบเนื้อหาหน้าที่จางเข้าเมื่อเปลี่ยนหน้า · ใช้ใน template.tsx ซึ่ง Next สร้างใหม่ทุกครั้งที่ segment ข้างใต้เปลี่ยน
 * data-entering เปิดให้ CSS ไล่แถว (.motion-item, tbody tr, .m-row) ในช่วงแรกเท่านั้น
 */
export function PageEnter({ children }: { children: ReactNode }) {
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setEntering(false), ENTERING_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="page-enter" data-entering={entering ? "" : undefined}>
      {children}
    </div>
  );
}
