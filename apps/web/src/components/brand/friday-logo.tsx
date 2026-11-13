import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import styles from "./friday-logo.module.css";

/*
 * โลโก้ Friday: ไทล์ 4 สี + คำว่า "friday" · ผู้ใช้สั่งให้ใช้แทนสี่เหลี่ยมตัว "F" ใน Canvas (2026-11-07)
 * ไม่มี hook จึงใช้ได้ทั้งใน server และ client component
 */

const TILES = [
  { x: 3, y: 4, fill: "#54ca94" },
  { x: 20, y: 4, fill: "#ffd66d" },
  { x: 3, y: 21, fill: "#ff7896" },
  { x: 20, y: 21, fill: "#a67cea" },
];

export function FridayMark({ className }: { className?: string }) {
  return (
    <svg className={cn(styles.mark, className)} viewBox="0 0 36 36" fill="none" aria-hidden="true">
      <g transform="rotate(-9 18 18)">
        {TILES.map((tile) => (
          <rect
            key={tile.fill}
            className={styles.tile}
            x={tile.x}
            y={tile.y}
            width="13"
            height="13"
            rx="4.5"
            fill={tile.fill}
          />
        ))}
      </g>
    </svg>
  );
}

export function FridayLogo({
  size = "md",
  tone = "light",
  tagline = true,
  label = "Friday Work Management",
  className,
}: {
  size?: "sm" | "md" | "lg";
  /** dark = วางบนพื้นสีเข้ม (แผงซ้ายของหน้า Login) */
  tone?: "light" | "dark";
  tagline?: boolean;
  /** ชื่อที่โปรแกรมอ่านหน้าจออ่าน เพราะ wordmark ที่เห็นเป็นตัวพิมพ์เล็กแยกชิ้น */
  label?: string;
  className?: string;
}) {
  return (
    <span className={cn(styles.logo, className)} data-size={size} data-tone={tone}>
      <FridayMark />
      <span className={styles.wordmark} aria-hidden="true">
        <span className={styles.name}>
          fr<b className={styles.i}>i</b>day<span className={styles.dot} />
        </span>
        {/* tagline เป็นส่วนหนึ่งของโลโก้ จึงไม่แปลตามภาษา */}
        {tagline && <small className={styles.tagline}>Work management</small>}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/*
 * ตัวโหลดของ Friday: ไทล์ 4 ชิ้นบินจากมุมเข้ามาประกอบเป็น logo แล้วเด้งทีละชิ้นแบบเดียวกับ logo
 * (เขียว → เหลือง → ม่วง → ชมพู) · ตรงกับหน้าเข้าสู่ระบบสำเร็จที่ผู้ใช้เลือกจาก mockup
 */
const LOADER_TILES = [
  { ...TILES[0], from: "-14px, -14px", spin: "-90deg", pop: 0 },
  { ...TILES[1], from: "14px, -14px", spin: "90deg", pop: 0.2 },
  { ...TILES[2], from: "-14px, 14px", spin: "90deg", pop: 0.6 },
  { ...TILES[3], from: "14px, 14px", spin: "-90deg", pop: 0.4 },
];

export function FridayLoader({ className }: { className?: string }) {
  return (
    <svg className={cn(styles.loader, className)} viewBox="0 0 36 36" fill="none" aria-hidden="true">
      <g transform="rotate(-9 18 18)">
        {LOADER_TILES.map((tile, index) => (
          <rect
            key={tile.fill}
            className={styles.loaderTile}
            style={
              {
                "--from": tile.from,
                "--spin": tile.spin,
                "--enter-delay": `${0.2 + index * 0.08}s`,
                "--pop-delay": `${tile.pop}s`,
              } as CSSProperties
            }
            x={tile.x}
            y={tile.y}
            width="13"
            height="13"
            rx="4.5"
            fill={tile.fill}
          />
        ))}
      </g>
    </svg>
  );
}
