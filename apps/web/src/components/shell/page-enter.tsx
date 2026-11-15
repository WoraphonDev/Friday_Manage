"use client";
import { createContext, useContext, useEffect, useState, type HTMLAttributes, type ReactNode } from "react";

/** ช่วงที่แถวและการ์ดที่เพิ่งขึ้นจะโผล่ไล่กัน · แถวที่ขึ้นหลังจากนี้ (สร้างงานใหม่ ลากการ์ด) ไม่ขยับซ้ำ */
const ENTERING_MS = 2000;

/** true = หน้าที่ครอบอยู่เพิ่งเปิดและกำลังเล่น animation เข้าหน้า */
const PageEntering = createContext(false);

function useEntering() {
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setEntering(false), ENTERING_MS);
    return () => clearTimeout(timer);
  }, []);
  return entering;
}

/**
 * กรอบเนื้อหาหน้าที่จางเข้าเมื่อเปลี่ยนหน้า · ใช้ใน template.tsx ซึ่ง Next สร้างใหม่ทุกครั้งที่ segment ข้างใต้เปลี่ยน
 * data-entering เปิดให้ CSS ไล่แถว (.motion-item, .motion-list > *, tbody tr, [role="row"], .m-row) ในช่วงแรกเท่านั้น
 */
export function PageEnter({ children }: { children: ReactNode }) {
  const entering = useEntering();
  return (
    <div className="page-enter" data-entering={entering ? "" : undefined}>
      <PageEntering.Provider value={entering}>{children}</PageEntering.Provider>
    </div>
  );
}

/**
 * เนื้อหาที่สลับในหน้าเดียวกันโดยไม่เปลี่ยน route (หัวข้อใน Admin / Settings, โฟลเดอร์, List ↔ Grid, เดือนในปฏิทิน)
 * ให้เคลื่อนแบบเดียวกับการเปลี่ยนหน้า · ผู้เรียกใส่ key ที่เปลี่ยนตามสิ่งที่สลับ เช่น <MotionSwap key={section}>
 * เป็น div ธรรมดา ถ้ากรอบเดิมเป็น flex / grid ให้ส่ง className / style ที่ต้องใช้ต่อมาด้วย (attribute อื่นของ div เช่น data-testid ส่งต่อให้กรอบ)
 */
export function MotionSwap({ children, className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const entering = useEntering();
  // ขึ้นพร้อมหน้า = หน้าจางเข้าให้แล้ว ไม่ต้องเลื่อนซ้อนอีกชั้น · ตัดสินครั้งเดียวตอนขึ้น (เปลี่ยนทีหลังจะทำให้ animation เริ่มใหม่)
  const pageEntering = useContext(PageEntering);
  const [withPage] = useState(pageEntering);
  return (
    <div {...rest} className={`${withPage ? "motion-swap-static" : "motion-swap"}${className ? ` ${className}` : ""}`} data-entering={entering ? "" : undefined}>
      {/* MotionSwap ข้างในที่ขึ้นพร้อมกรอบนี้ (เช่น สัปดาห์ในรายงานที่สลับมาพร้อมหัวข้อ) ก็ไม่เลื่อนซ้อนเช่นกัน */}
      <PageEntering.Provider value={entering}>{children}</PageEntering.Provider>
    </div>
  );
}
