import { api } from "@/lib/api";
import type { LoginMethods, Staff } from "@/lib/types";

/** ขั้นที่ 1: อีเมล + รหัสผ่าน → mfaToken อายุ 5 นาที (ยังไม่ได้ session) */
export const loginWithPassword = (email: string, password: string) => api.post<{ mfaToken: string; email: string }>("/auth/login/password", { email, password });

/** ขั้นที่ 2: รหัส 6 หลักจากแอป Authenticator → ops-api ตั้ง cookie `fm_ops` */
export const loginWithCode = async (mfaToken: string, code: string) => (await api.post<{ staff: Staff }>("/auth/login/totp", { mfaToken, code })).staff;

export interface TotpSetup {
  secret: string;
  otpauthUrl: string;
  email: string;
  setupToken: string;
}

/** เริ่มตั้งรหัสผ่าน + แอป: ด้วยลิงก์เชิญ (enrollToken) หรือ session ที่ยืนยันตัวตนซ้ำแล้ว */
export const startPasswordSetup = (enrollToken?: string) => api.post<TotpSetup>("/auth/password/setup", enrollToken ? { enrollToken } : {});

export const finishPasswordSetup = (setupToken: string, password: string, code: string) => api.post<{ ok: true; status: string }>("/auth/password/verify", { setupToken, password, code });

export const reauthWithCode = (code: string) => api.post("/auth/reauth/totp", { code });

export const fetchMethods = () => api.get<{ methods: LoginMethods }>("/auth/me").then((r) => r.methods);
