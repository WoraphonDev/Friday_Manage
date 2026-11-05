import common from "../../messages/th/common.json";

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
              common.app.unknownError,
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
        method,
        headers,
        credentials: "include",
        body:
          body === undefined ? undefined : form ? body : JSON.stringify(body),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ApiError(0, "network_error", common.app.networkError);
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
        payload?.message ?? common.app.unknownError,
        payload?.details ?? {},
        payload?.requestId,
      );
      if (response.status === 401 && redirectOnUnauthorized)
        emit(API_UNAUTHORIZED, error);
      if (response.status === 402) emit(API_PLAN_LIMIT, error);
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
