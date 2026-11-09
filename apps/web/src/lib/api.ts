import commonTh from "../../messages/th/common.json";
import commonEn from "../../messages/en/common.json";
import { pageLocale } from "./format";

/** ข้อความ error ของ client เองตามภาษาของหน้า (W21) · error จาก API ใช้ข้อความที่ API ส่งมา */
const appText = () => (pageLocale() === "en" ? { ...commonTh.app, ...commonEn.app } : commonTh.app);

export class ApiError extends Error {
  readonly latest: unknown;
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
    this.latest = details.latest;
  }
}

/**
 * รหัสอ้างอิงที่ควรโชว์ผู้ใช้ (ผู้ใช้ขอ 2026-11-09: ไม่แสดงตอน error ทั่วไป)
 * แสดงเฉพาะความผิดพลาดของระบบ (5xx) หรือเชื่อมต่อไม่ได้ ซึ่งผู้ใช้ต้องใช้รหัสตอนแจ้งปัญหา
 * error ที่แก้เองได้ (กรอกผิด ไม่มีสิทธิ์ ข้อมูลชนกัน ฯลฯ) ไม่แสดง
 */
export function supportId(error: unknown): string | null {
  if (!(error instanceof ApiError) || !error.requestId) return null;
  return error.status >= 500 || error.status === 0 ? error.requestId : null;
}

export const API_UNAUTHORIZED = "friday:unauthorized";
export const API_PLAN_LIMIT = "friday:plan-limit";
export const ifMatch = (version: string | number) =>
  String(version).startsWith('"') ? String(version) : `"${version}"`;
export interface ApiResult<T> {
  data: T;
  etag: string | null;
}
export interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  etag?: string | number;
  redirectOnUnauthorized?: boolean;
}

/** API ที่ตอบ 422 พร้อม details.confirmable + confirmField ให้ถามผู้ใช้แล้วส่งคำขอเดิมซ้ำพร้อมช่องยืนยัน */
export interface ConfirmRequest { code: string; message: string; details: Record<string, unknown> }
let confirmer: ((request: ConfirmRequest) => Promise<boolean>) | null = null;
/** ConfirmHost (ใน Providers) ลงทะเบียนกล่องยืนยันกลาง · ไม่ลงทะเบียน = ส่ง error ให้ผู้เรียกตามเดิม */
export function setConfirmHandler(handler: typeof confirmer) {
  confirmer = handler;
}
/** ผู้ใช้กดยกเลิกในกล่องยืนยัน · หน้าจอไม่ต้องแสดงเป็นข้อผิดพลาด */
export const isConfirmCancelled = (error: unknown) =>
  error instanceof ApiError && error.code === "confirm_cancelled";

function emit(name: string, detail: unknown) {
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent(name, { detail }));
}

export class ApiClient {
  private csrfRequest?: Promise<string>;
  constructor(
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
    private readonly base = "/api/v1",
  ) {}

  private async csrf() {
    const cookie =
      typeof document === "undefined"
        ? undefined
        : document.cookie
            .split("; ")
            .find((item) => item.startsWith("fm_csrf="))
            ?.slice(8);
    if (cookie) return decodeURIComponent(cookie);
    if (!this.csrfRequest) {
      this.csrfRequest = this.fetcher(`${this.base}/auth/csrf`, {
        credentials: "include",
      })
        .then(async (response) => {
          if (!response.ok)
            throw new ApiError(
              response.status,
              "csrf_failed",
              appText().unknownError,
            );
          return ((await response.json()) as { csrfToken: string }).csrfToken;
        })
        .finally(() => {
          this.csrfRequest = undefined;
        });
    }
    return this.csrfRequest;
  }

  async requestWithMeta<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<ApiResult<T>> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
      throw new TypeError("API path must be relative to /api/v1");
    const {
      body,
      etag,
      redirectOnUnauthorized = !path.startsWith("/auth/"),
      ...init
    } = options;
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    if (!["GET", "HEAD", "OPTIONS"].includes(method))
      headers.set("x-csrf-token", await this.csrf());
    if (etag !== undefined) headers.set("If-Match", ifMatch(etag));
    const form = typeof FormData !== "undefined" && body instanceof FormData;
    if (body !== undefined && !form)
      headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        ...init,
        // Module/ลูกงานเปลี่ยนได้โดย ETag หลักคงเดิม ให้ React Query เป็นแคชข้อมูลเพียงชั้นเดียว
        cache: init.cache ?? "no-store",
        method,
        headers,
        credentials: "include",
        body:
          body === undefined ? undefined : form ? body : JSON.stringify(body),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ApiError(0, "network_error", appText().networkError);
    }
    const data =
      response.status === 204
        ? undefined
        : await response.json().catch(() => undefined);
    if (!response.ok) {
      const payload = data?.error;
      const error = new ApiError(
        response.status,
        payload?.code ?? "unknown_error",
        payload?.message ?? appText().unknownError,
        payload?.details ?? {},
        payload?.requestId,
      );
      if (response.status === 401 && redirectOnUnauthorized)
        emit(API_UNAUTHORIZED, error);
      if (response.status === 402) emit(API_PLAN_LIMIT, error);
      // เช่น Sub-task วันที่เกินช่วง Task แม่ หรือ Acceptance criteria ยังไม่ครบ: ทุกหน้าใช้กล่องยืนยันเดียวกัน
      const field = error.details.confirmField;
      const plain = typeof body === "object" && body !== null && !form && !Array.isArray(body);
      if (confirmer && error.details.confirmable === true && typeof field === "string" && plain && !(body as Record<string, unknown>)[field]) {
        const ok = await confirmer({ code: error.code, message: error.message, details: error.details });
        if (ok) return this.requestWithMeta<T>(path, { ...options, body: { ...(body as Record<string, unknown>), [field]: true } });
        throw new ApiError(error.status, "confirm_cancelled", appText().confirmCancelled, error.details, error.requestId);
      }
      throw error;
    }
    return { data: data as T, etag: response.headers.get("etag") };
  }

  async request<T>(path: string, options?: RequestOptions) {
    return (await this.requestWithMeta<T>(path, options)).data;
  }
  get<T>(path: string, options?: RequestOptions) {
    return this.request<T>(path, options);
  }
  post<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: "POST", body });
  }
  put<T>(path: string, body: unknown) {
    return this.request<T>(path, { method: "PUT", body });
  }
  patch<T>(path: string, body: unknown, etag: string | number) {
    return this.request<T>(path, { method: "PATCH", body, etag });
  }
  delete<T>(path: string, options: RequestOptions = {}) {
    return this.request<T>(path, { ...options, method: "DELETE" });
  }
}

export const api = new ApiClient();
