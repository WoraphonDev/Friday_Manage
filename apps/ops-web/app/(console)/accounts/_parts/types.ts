/** บัญชีลูกค้าระดับบริษัท (ช่วง 3) · ตรงกับ ops-api › accounts/accounts.module */
export interface Dur {
  n: number;
  unit: "h" | "d";
}
export interface Contact {
  name: string;
  email?: string;
  phone?: string;
  role: "signer" | "billing" | "it" | "other";
}
export interface Account {
  id: string;
  name: string;
  taxIds: string[];
  kind: "standard" | "enterprise";
  managerId: string | null;
  managerName: string | null;
  contacts: Contact[];
  notes: string | null;
  contractStart: string | null;
  contractEnd: string | null;
  /** สตางค์ต่อปี · null สำหรับคนที่ไม่เห็นยอดเงิน */
  contractValue: number | null;
  contractSeats: number | null;
  contractSla: { first: Dur | null; resolve: Dur | null } | null;
  lastContactAt: string | null;
  file: { name: string; size: number; at: string } | null;
  numbers: {
    workspaces: number;
    seats: number;
    seatLimit: number;
    mrr: number | null;
    minHealth: { score: number; workspace: { id: string; name: string } } | null;
    openTickets: number;
    overdue: number | null;
    overdueAny: boolean;
    active30: number;
  };
  can?: { edit: boolean; contract: boolean; remove: boolean };
  daysLeft?: number;
}
export interface Suggestion {
  key: string;
  taxId: string;
  name: string | null;
  count: number;
  workspaces: { id: string; name: string; slug: string }[];
}
export const ACCOUNTS_KEY = ["ops", "accounts"] as const;
