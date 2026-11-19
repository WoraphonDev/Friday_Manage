// issue.assigned มี role (BA / SA / QA) และ removed มาใน payload · ใช้ร่วมกันระหว่าง Inbox และ Toast ของกระดิ่ง
const ROLE_LABEL: Record<string, string> = { ba: "BA", sa: "SA", qa: "QA / Reviewer" };

type Translate = (key: never, values?: never) => string;

/** คำกริยาของแจ้งเตือนมอบหมายงานตามบทบาท · null = ใช้คำของประเภทเหตุการณ์ตามปกติ */
export function assignVerb(t: Translate, n: { eventType: string; payload: Record<string, unknown> }): string | null {
  if (n.eventType !== "issue.assigned") return null;
  const role = typeof n.payload.role === "string" ? ROLE_LABEL[n.payload.role] : undefined;
  const removed = n.payload.removed === true;
  if (role) return t((removed ? "assignVerbs.removedRole" : "assignVerbs.addedRole") as never, { role } as never);
  return removed ? t("assignVerbs.removed" as never) : null;
}
