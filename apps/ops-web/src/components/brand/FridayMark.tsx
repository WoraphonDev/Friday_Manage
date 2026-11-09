/*
 * โลโก้ Friday (ไทล์ 4 สี) ชุดเดียวกับ apps/web › components/brand/friday-logo · ผู้ใช้สั่งให้ใส่ใน Friday Ops แทนสี่เหลี่ยมตัว "F" (2026-11-10)
 * สีของไทล์เป็นสีแบรนด์ (ไม่เปลี่ยนตามธีม) จึงอยู่ใน SVG ไม่ใช่ token
 */
const TILES = [
  { x: 3, y: 4, fill: "#54ca94" },
  { x: 20, y: 4, fill: "#ffd66d" },
  { x: 3, y: 21, fill: "#ff7896" },
  { x: 20, y: 21, fill: "#a67cea" },
];

export function FridayMark({ className = "ops-logo-mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 36 36" fill="none" aria-hidden="true">
      <g transform="rotate(-9 18 18)">
        {TILES.map((tile) => (
          <rect key={tile.fill} className="ops-logo-tile" x={tile.x} y={tile.y} width="13" height="13" rx="4.5" fill={tile.fill} />
        ))}
      </g>
    </svg>
  );
}
