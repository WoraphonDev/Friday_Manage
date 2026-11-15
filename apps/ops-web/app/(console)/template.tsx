import { PageEnter } from "@/components/shell/page-enter";

/** Next สร้าง template ใหม่ทุกครั้งที่เปลี่ยนหน้า เนื้อหาจึงจางเข้า (เมนูซ้ายและแถบบนใน layout คงอยู่)
 * กรอบ .page-enter ใน .ops-main ต่อ flex คอลัมน์และระยะห่างเดิมให้ (ดู ops.css ส่วนการเคลื่อนไหว) หน้าตาตอนนิ่งจึงเหมือนเดิม */
export default function Template({ children }: { children: React.ReactNode }) {
  return <PageEnter>{children}</PageEnter>;
}
