// ข้อมูลสมมติของ GET p/overview ใช้ร่วมใน test ของ Overview (W05) และส่วนแผน (W15)
import type { Overview } from "../../app/w/[ws]/p/[key]/table/_components/types";

export const person = (id: string, displayName: string) => ({ id, displayName });
export function overview(): Overview {
  return {
    project: { key: "DE", name: "แผนพัฒนาผลิตภัณฑ์", clientName: "ลูกค้าตัวอย่าง", description: "ระบบตัวอย่างครบวงจร", status: "active", startDate: "2026-11-05", goliveDate: "2027-04-21", progressMethod: "weighted", owner: person("u0", "หัวหน้าตัวอย่าง"), memberCount: 12, moduleCount: 2, scope: { inScope: ["ระบบวงเงิน"], outScope: ["ระบบบัญชีเดิม"], deliverables: [], acceptance: [], assumptions: [] } },
    today: "2026-12-02",
    progress: { pct: 22, tasks: { done: 72, total: 334 }, md: { done: 189, total: 944, pct: 20 }, time: { elapsedWorkingDays: 20, totalWorkingDays: 111, pct: 18 }, remainingWorkingDays: 91, lastPlanEnd: "2027-04-21", nextMilestone: { id: "m1", name: "Go-live ระยะแรก", date: "2027-01-26", daysLeft: 55 } },
    health: { level: "off_track", plannedPct: 30, actualPct: 20, gapPct: 10, behindPlan: 45, overdue: { count: 7, topAssignee: { person: person("u1", "ผู้พัฒนาหนึ่ง"), count: 4 } }, capacity: { remainingMd: 700, teamMdPerWeek: 24, weeksNeeded: 29, weeksLeft: 24 } },
    kpis: { total: 334, done: 72, overdue: 7, overdueDelta: 2, dueToday: 2, laterThisWeek: 5, laterThisWeekRange: { from: "2026-12-03", to: "2026-12-06" }, doneLast7Days: 15, doneDelta: 4 },
    lists: {
      overdue: [{ key: "DE-23", type: "Task", title: "งานที่เลยกำหนด", status: { name: "In progress", category: "in_progress" }, module: { id: "m-a", name: "Module A", color: "#1d4ed8" }, phase: null, parentKey: null, planEnd: "2026-11-23", lateDays: 9, completedOn: null, assignees: [person("u1", "ผู้พัฒนาหนึ่ง")] }],
      dueToday: [{ key: "DE-35", type: "Task", title: "งานครบวันนี้", status: { name: "To do", category: "todo" }, module: null, phase: null, parentKey: null, planEnd: "2026-12-02", lateDays: 0, completedOn: null, assignees: [] }],
      laterThisWeek: [],
      doneLast7Days: [],
    },
    doneDaily: [0, 1, 2, 3, 4, 5, 0].map((count, i) => ({ date: `2026-11-${String(26 + i).padStart(2, "0")}`.replace("2026-11-31", "2026-12-01").replace("2026-11-32", "2026-12-02"), count, workingDay: true })),
    burnup: { unit: "md", total: 944, points: [{ weekStart: "2026-11-02", weekEnd: "2026-11-08", planned: 50, done: 40 }, { weekStart: "2026-11-09", weekEnd: "2026-11-15", planned: 120, done: 100 }] },
    modules: [{ id: "m-a", name: "Module A", color: "#1d4ed8", pct: 30, done: 10, total: 40, overdue: 3, notStarted: false }, { id: "m-b", name: "Module B", color: null, pct: 0, done: 0, total: 20, overdue: 0, notStarted: true }],
    statusBreakdown: { columns: [{ id: "todo", name: "To do", category: "todo", count: 200, pct: 60 }, { id: "done", name: "Done", category: "done", count: 134, pct: 40 }] },
    milestones: [{ id: "m1", name: "Go-live ระยะแรก", date: "2027-01-26", daysLeft: 55, linkedIssues: 3, donePct: 40, basis: "linked" }],
    workloadThisWeek: { from: "2026-11-30", to: "2026-12-06", people: [{ person: person("u1", "ผู้พัฒนาหนึ่ง"), md: 6, capacityMd: 5, utilizationPct: 120, over: true }] },
    activity: [{ id: "a1", issue: { key: "DE-23", title: "งานที่เลยกำหนด" }, actor: person("u1", "ผู้พัฒนาหนึ่ง"), actorKind: "user", verb: "updated", field: "statusId", createdAt: "2026-12-02T02:00:00Z" }],
  };
}
