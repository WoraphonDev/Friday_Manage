import { PageEnter } from "@/components/shell/page-enter";

/** Next สร้าง template ใหม่ทุกครั้งที่เปลี่ยนหน้า เนื้อหาจึงจางเข้า (layout และ sidebar คงอยู่) */
export default function Template({ children }: { children: React.ReactNode }) {
  return <PageEnter>{children}</PageEnter>;
}
