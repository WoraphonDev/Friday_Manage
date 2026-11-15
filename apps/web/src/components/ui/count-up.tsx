"use client";
import { useEffect, useRef } from "react";
import { motionDisabled, motionMs } from "@/lib/motion";

const NUMBER = /-?\d[\d,]*(?:\.\d+)?/;

/**
 * ตัวเลขสรุปที่นับขึ้นจาก 0 ตอนแสดงครั้งแรก และนับจากค่าเดิมไปค่าใหม่เมื่อค่าเปลี่ยน
 * รับข้อความที่มีตัวเลขปนได้ (เช่น "12 สัปดาห์") จะนับเฉพาะตัวเลขตัวแรก · ไม่มีตัวเลข (เช่น "—") แสดงตรง ๆ
 * render แรกเป็นค่าจริงเสมอ (SSR และโปรแกรมอ่านหน้าจอได้ค่าถูก) แล้วค่อยเขียนตัวเลขระหว่างทางลง DOM ในแต่ละเฟรม
 */
export function CountUp({ value }: { value: string | number }) {
  const text = String(value);
  const ref = useRef<HTMLSpanElement>(null);
  // ค่าที่แสดงอยู่จริง (ระหว่างนับด้วย) · ค่าเปลี่ยนกลางทางจึงนับต่อจากตรงนั้น และ Strict Mode ที่รัน effect ซ้ำยังนับจาก 0
  const shown = useRef<number | null>(null);
  useEffect(() => {
    // เขียนผ่าน text node ที่ React สร้าง (ไม่แทนที่ node) React จึงอัปเดตค่าถัดไปได้ตามปกติ
    const node = ref.current?.firstChild;
    if (!(node instanceof Text)) return;
    const match = NUMBER.exec(text);
    const target = match ? Number(match[0].replace(/,/g, "")) : null;
    const from = shown.current ?? 0;
    if (!match || target === null || motionDisabled() || from === target) {
      shown.current = target;
      node.nodeValue = text;
      return;
    }
    const raw = match[0];
    const decimals = raw.split(".")[1]?.length ?? 0;
    const grouped = raw.includes(",");
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + raw.length);
    const format = (n: number) =>
      grouped
        ? n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
        : n.toFixed(decimals);
    const duration = motionMs("--motion-dur-long", ref.current!) || 1500;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const current = from + (target - from) * (1 - Math.pow(1 - p, 3));
      shown.current = p < 1 ? current : target;
      node.nodeValue = p < 1 ? before + format(current) + after : text;
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    // ค่าเปลี่ยนกลางทาง: effect รอบใหม่นับต่อจากค่าใหม่เอง ไม่ต้องเขียนค่าเดิมกลับ
    return () => cancelAnimationFrame(frame);
  }, [text]);
  return <span ref={ref}>{text}</span>;
}
