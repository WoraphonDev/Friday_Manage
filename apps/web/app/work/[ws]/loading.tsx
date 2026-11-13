import { LoadingState } from "@/components/ui";

// ระหว่างเปลี่ยนหน้าใน Workspace ให้เห็นตัวโหลดเดียวกับตอนรอข้อมูล โดย Sidebar ยังอยู่ที่เดิม
export default function Loading() {
  return <LoadingState />;
}
