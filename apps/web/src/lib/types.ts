export interface Me {
  id: string;
  email: string;
  displayName: string;
  locale: string;
  yearFormat: "BE" | "CE";
  timezone: string;
}
export interface Workspace {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  status: string;
  role: "owner" | "admin" | "member" | "guest";
}
export interface Project {
  id: string;
  key: string;
  name: string;
  color: string | null;
  description?: string | null;
  status: string;
  myRole: string | null;
  joined: boolean;
  startDate: string;
  goliveDate: string;
  version?: number;
}
export interface Permissions {
  role: "admin" | "member" | "viewer" | null;
  guestViewer: boolean;
  permissions: string[];
}
export interface Person {
  id: string;
  displayName: string;
  /** ตำแหน่งในโปรเจกต์ (มีเมื่ออ่านจากรายชื่อสมาชิกโปรเจกต์) · ใช้กรองช่องเลือก BA / SA / Dev / QA */
  positions?: string[];
  initials?: string;
  avatarUrl?: string | null;
  color?: string;
}
export interface NotificationSummary {
  total: number;
  workspaces: { id: string; slug: string; name: string; unread: number }[];
}
export interface List<T> {
  items: T[];
  nextCursor?: string | null;
}
