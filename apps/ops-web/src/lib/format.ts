const tz = "Asia/Bangkok";
const dateFmt = new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", year: "numeric", timeZone: tz });
const dateTimeFmt = new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: tz });
const number = new Intl.NumberFormat("th-TH");
const baht = new Intl.NumberFormat("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export const formatDate = (iso: string | null | undefined) => (iso ? dateFmt.format(new Date(iso)) : "–");
export const formatDateTime = (iso: string | null | undefined) => (iso ? dateTimeFmt.format(new Date(iso)) : "–");
export const formatNumber = (n: number) => number.format(n);
/** เงินในระบบเป็นสตางค์ */
export const formatBaht = (satang: number) => `฿${baht.format(satang / 100)}`;
export const daysLeft = (iso: string | null | undefined, now = Date.now()) => (iso ? Math.ceil((Date.parse(iso) - now) / 86_400_000) : null);
export const minutesBetween = (from: string, to: string | null, now = Date.now()) => Math.max(0, Math.round(((to ? Date.parse(to) : now) - Date.parse(from)) / 60_000));
