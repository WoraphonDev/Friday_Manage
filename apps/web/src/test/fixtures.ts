import type {
  Me,
  NotificationSummary,
  Permissions,
  Project,
  Workspace,
} from "@/lib/types";

export const me: Me = {
  id: "sample-lead",
  email: "lead@example.com",
  displayName: "หัวหน้าทีมตัวอย่าง",
  locale: "th",
  yearFormat: "BE",
  timezone: "Asia/Bangkok",
};
export const workspaces: Workspace[] = [
  {
    id: "sample-ws",
    slug: "sample",
    name: "ทีมตัวอย่าง",
    logoUrl: null,
    status: "active",
    role: "owner",
  },
  {
    id: "sample-ws-two",
    slug: "other",
    name: "อีกทีมตัวอย่าง",
    logoUrl: null,
    status: "active",
    role: "member",
  },
];
export const projects: Project[] = [
  {
    id: "sample-project",
    key: "DE",
    name: "แผนพัฒนาผลิตภัณฑ์",
    color: "#334155",
    status: "active",
    myRole: "admin",
    joined: true,
    startDate: "2026-11-05",
    goliveDate: "2027-04-21",
    version: 1,
  },
];
export const permissions: Permissions = {
  role: "admin",
  guestViewer: false,
  permissions: [
    "project.view",
    "issue.create",
    "issue.edit",
    "project.settings",
    "project.workload.view",
    "project.reports.view",
    "project.automation",
    "project.baseline",
  ],
};
export const summary: NotificationSummary = {
  total: 5,
  workspaces: [
    { id: workspaces[0].id, slug: "sample", name: "ทีมตัวอย่าง", unread: 3 },
    { id: workspaces[1].id, slug: "other", name: "อีกทีมตัวอย่าง", unread: 2 },
  ],
};
