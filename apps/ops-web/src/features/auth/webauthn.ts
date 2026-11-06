import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api, ApiError } from "@/lib/api";
import type { Staff } from "@/lib/types";

type Options<T> = { options: T; challengeToken: string };

/** ล็อกอิน: ขอ challenge (เซ็นเป็นโทเค็น 5 นาที) → ให้ key เซ็น → ส่งกลับ · สำเร็จแล้ว ops-api ตั้ง cookie `fm_ops` */
export async function loginWithKey(email: string) {
  const { options, challengeToken } = await api.post<Options<Parameters<typeof startAuthentication>[0]["optionsJSON"]>>("/auth/login/options", { email });
  const response = await startAuthentication({ optionsJSON: options });
  return (await api.post<{ staff: Staff }>("/auth/login/verify", { challengeToken, response })).staff;
}

/** ลงทะเบียน key: ด้วย enrollToken (พนักงานใหม่) หรือ session ที่มีอยู่ (key สำรอง) */
export async function registerKey(input: { enrollToken?: string; name: string }) {
  const { options, challengeToken } = await api.post<Options<Parameters<typeof startRegistration>[0]["optionsJSON"]>>("/auth/register/options", input);
  const response = await startRegistration({ optionsJSON: options });
  return api.post<{ registered: boolean; credentialId: string; keys: number }>("/auth/register/verify", { challengeToken, response, name: input.name });
}

/** error จาก browser (ผู้ใช้กดยกเลิก / key ซ้ำ) แปลงเป็นข้อความที่อ่านเข้าใจ */
export function keyErrorKind(error: unknown): "cancelled" | "keyExists" | null {
  if (error instanceof ApiError || !(error instanceof Error)) return null;
  const code = (error as { code?: string }).code;
  if (error.name === "NotAllowedError" || error.name === "AbortError" || code === "ERROR_CEREMONY_ABORTED") return "cancelled";
  if (error.name === "InvalidStateError" || code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") return "keyExists";
  return null;
}
