import ops from "../../messages/th/ops.json";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** ops-api ตอบ 401 → พากลับหน้า Login (ฟังใน Providers) */
export const OPS_UNAUTHORIZED = "friday-ops:unauthorized";
/** ผ่าน rewrite ใน next.config ไปที่ `<OPS_API_ORIGIN>/ops/*` */
export const OPS_BASE = "/ops-api";

/**
 * client ของ ops-api · ไม่มี CSRF token: cookie `fm_ops` เป็น SameSite=Strict และ ops-api ตรวจ Origin ของคำขอเขียน
 * (browser ใส่ Origin ให้เองเพราะเรียกใน origin เดียวกันผ่าน proxy)
 */
export class OpsClient {
  constructor(private readonly fetcher: typeof fetch = (...args) => fetch(...args)) {}

  async request<T>(path: string, init: { method?: string; body?: unknown; redirectOnUnauthorized?: boolean } = {}): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new TypeError("path ต้องเป็น relative ของ /ops-api");
    const { method = "GET", body, redirectOnUnauthorized = !path.startsWith("/auth/") } = init;
    let response: Response;
    try {
      response = await this.fetcher(`${OPS_BASE}${path}`, {
        method,
        credentials: "include",
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ApiError(0, "network_error", ops.ui.networkError);
    }
    const data = response.status === 204 ? undefined : await response.json().catch(() => undefined);
    if (!response.ok) throw this.failure(response, data, redirectOnUnauthorized);
    return data as T;
  }
  /** ไฟล์แนบ (สลิป, 50 ทวิ) เป็น Blob · ใช้แสดงในหน้าโดยไม่ต้องฝัง iframe ของ ops-api (X-Frame-Options: DENY) */
  async file(path: string): Promise<Blob> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new TypeError("path ต้องเป็น relative ของ /ops-api");
    let response: Response;
    try {
      response = await this.fetcher(`${OPS_BASE}${path}`, { credentials: "include" });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ApiError(0, "network_error", ops.ui.networkError);
    }
    if (!response.ok) throw this.failure(response, await response.json().catch(() => undefined), true);
    return response.blob();
  }
  /** ส่งไฟล์ตรง ๆ (application/octet-stream) · ชื่อไฟล์ใน X-File-Name · error แบบเดียวกับคำขอ JSON */
  async upload<T>(path: string, file: Blob, name: string): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new TypeError("path ต้องเป็น relative ของ /ops-api");
    let response: Response;
    try {
      response = await this.fetcher(`${OPS_BASE}${path}`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(name) }, body: file });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ApiError(0, "network_error", ops.ui.networkError);
    }
    const data = await response.json().catch(() => undefined);
    if (!response.ok) throw this.failure(response, data, true);
    return data as T;
  }
  private failure(response: Response, data: { error?: { code?: string; message?: string; details?: unknown; requestId?: string } } | undefined, redirectOnUnauthorized: boolean) {
    const payload = data?.error;
    const error = new ApiError(
      response.status,
      payload?.code ?? "unknown_error",
      payload?.message ?? ops.ui.unknownError,
      payload?.details && typeof payload.details === "object" && !Array.isArray(payload.details) ? (payload.details as Record<string, unknown>) : { issues: payload?.details },
      // ops-api ยังไม่ใส่ requestId ใน body (คำขอนอก lane) · รองรับทั้งใน body และ header ของ reverse proxy
      payload?.requestId ?? response.headers.get("x-request-id") ?? undefined,
    );
    // reauth_required (ต้องแตะกุญแจซ้ำ) ก็ตอบ 401 แต่ session ยังอยู่ → ให้ useReauth จัดการ ไม่ใช่เซสชันหมดอายุ
    if (response.status === 401 && error.code !== "reauth_required" && redirectOnUnauthorized && typeof window !== "undefined") window.dispatchEvent(new CustomEvent(OPS_UNAUTHORIZED));
    return error;
  }
  get<T>(path: string) {
    return this.request<T>(path);
  }
  post<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: "POST", body: body ?? {} });
  }
  put<T>(path: string, body: unknown) {
    return this.request<T>(path, { method: "PUT", body });
  }
  patch<T>(path: string, body: unknown) {
    return this.request<T>(path, { method: "PATCH", body });
  }
  delete<T>(path: string) {
    return this.request<T>(path, { method: "DELETE" });
  }
}

export const api = new OpsClient();
