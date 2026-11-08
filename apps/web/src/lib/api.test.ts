import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import {
  API_PLAN_LIMIT,
  API_UNAUTHORIZED,
  ApiClient,
  ApiError,
  ifMatch,
  setConfirmHandler,
  supportId,
} from "./api";
import { server } from "@/test/server";

describe("API client", () => {
  it("supportId แสดงรหัสอ้างอิงเฉพาะความผิดพลาดของระบบ (5xx / เชื่อมต่อไม่ได้) ไม่ใช่ error ที่ผู้ใช้แก้เองได้", () => {
    expect(supportId(new ApiError(400, "invalid_input", "x", {}, "req_400"))).toBeNull();
    expect(supportId(new ApiError(409, "conflict", "x", {}, "req_409"))).toBeNull();
    expect(supportId(new ApiError(500, "internal_error", "x", {}, "req_500"))).toBe("req_500");
    expect(supportId(new ApiError(0, "network", "x", {}, "req_0"))).toBe("req_0");
    expect(supportId(new Error("x"))).toBeNull();
  });

  it("GET ส่ง cookie และคืน ETag สำหรับ If-Match", async () => {
    let credentials = "";
    let cache = "";
    server.use(
      http.get("*/api/v1/example", ({ request }) => {
        credentials = request.credentials;
        cache = request.cache;
        return HttpResponse.json({ version: 4 }, { headers: { ETag: '"4"' } });
      }),
    );
    expect(await new ApiClient().requestWithMeta("/example")).toEqual({
      data: { version: 4 },
      etag: '"4"',
    });
    expect(credentials).toBe("include");
    expect(cache).toBe("no-store");
    expect(ifMatch(4)).toBe('"4"');
    expect(ifMatch('"4"')).toBe('"4"');
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "%s ดึงและส่ง CSRF token",
    async (method) => {
      server.use(
        http.all("*/api/v1/example", async ({ request }) =>
          HttpResponse.json({
            csrf: request.headers.get("x-csrf-token"),
            method: request.method,
            etag: request.headers.get("If-Match"),
          }),
        ),
      );
      expect(
        await new ApiClient().request("/example", {
          method,
          body: { name: "ทดสอบ" },
          etag: 2,
        }),
      ).toEqual({ csrf: "test-csrf", method, etag: '"2"' });
    },
  );

  it("ใช้ CSRF cookie ล่าสุดและส่ง FormData โดยไม่ทับ multipart boundary", async () => {
    document.cookie = "fm_csrf=current-token; path=/";
    server.use(
      http.post("*/api/v1/upload", ({ request }) =>
        HttpResponse.json({
          csrf: request.headers.get("x-csrf-token"),
          type: request.headers.get("content-type"),
        }),
      ),
    );
    const body = new FormData();
    body.set("file", new File(["sample"], "sample.txt"));
    const result = await new ApiClient().post<{ csrf: string; type: string }>(
      "/upload",
      body,
    );
    expect(result.csrf).toBe("current-token");
    expect(result.type).toMatch(/^multipart\/form-data; boundary=/);
  });

  it("คำขอพร้อมกันใช้การดึง CSRF ร่วมกัน", async () => {
    let tokens = 0;
    server.use(
      http.get("*/api/v1/auth/csrf", () => {
        tokens++;
        return HttpResponse.json({ csrfToken: "shared" });
      }),
      http.post(
        "*/api/v1/example",
        () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const client = new ApiClient();
    const result = await Promise.all([
      client.post("/example"),
      client.post("/example"),
    ]);
    expect(result).toEqual([undefined, undefined]);
    expect(tokens).toBe(1);
  });

  it("401 ส่งเหตุการณ์หมด session แต่ invalid_credentials บนหน้า login ไม่ redirect", async () => {
    const listener = vi.fn();
    window.addEventListener(API_UNAUTHORIZED, listener);
    server.use(
      http.get("*/api/v1/example", () =>
        HttpResponse.json(
          {
            error: {
              code: "unauthorized",
              message: "หมดอายุ",
              requestId: "req_test",
            },
          },
          { status: 401 },
        ),
      ),
      http.post("*/api/v1/auth/login", () =>
        HttpResponse.json(
          { error: { code: "invalid_credentials", message: "ไม่ถูกต้อง" } },
          { status: 401 },
        ),
      ),
    );
    try {
      await expect(new ApiClient().get("/example")).rejects.toMatchObject({
        status: 401,
        requestId: "req_test",
      });
      await expect(
        new ApiClient().post("/auth/login", {}),
      ).rejects.toMatchObject({ code: "invalid_credentials" });
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(API_UNAUTHORIZED, listener);
    }
  });

  it("402 ส่งรายละเอียดให้ dialog และ 409 คืน latest ให้หน้าจอ", async () => {
    const listener = vi.fn();
    window.addEventListener(API_PLAN_LIMIT, listener);
    server.use(
      http.get("*/api/v1/limit", () =>
        HttpResponse.json(
          {
            error: {
              code: "plan_limit_reached",
              message: "เต็ม",
              details: { current: 5, limit: 5 },
            },
          },
          { status: 402 },
        ),
      ),
      http.get("*/api/v1/conflict", () =>
        HttpResponse.json(
          {
            error: {
              code: "conflict",
              message: "แก้ไขชนกัน",
              details: { latest: { version: 2 } },
            },
          },
          { status: 409 },
        ),
      ),
    );
    try {
      await expect(new ApiClient().get("/limit")).rejects.toMatchObject({
        details: { current: 5, limit: 5 },
      });
      expect(listener).toHaveBeenCalledTimes(1);
      await expect(new ApiClient().get("/conflict")).rejects.toMatchObject({
        latest: { version: 2 },
      });
    } finally {
      window.removeEventListener(API_PLAN_LIMIT, listener);
    }
  });

  it("network error เป็น ApiError และ response ที่ไม่ใช่ JSON มี fallback", async () => {
    server.use(
      http.get("*/api/v1/example", () => HttpResponse.error()),
      http.get("*/api/v1/html", () =>
        HttpResponse.text("Bad gateway", { status: 502 }),
      ),
    );
    await expect(new ApiClient().get("/example")).rejects.toMatchObject({
      code: "network_error",
      status: 0,
    });
    await expect(new ApiClient().get("/html")).rejects.toBeInstanceOf(ApiError);
  });

  it("ไม่ส่ง session และ CSRF ไป URL ภายนอก", async () => {
    await expect(
      new ApiClient().post("//example.com", {}),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("คำขอที่ต้องยืนยัน (422 + confirmField)", () => {
  function confirmServer() {
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.patch("*/api/v1/issues/DE-2", async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        if (!body.extendParent)
          return HttpResponse.json({ error: { code: "subtask_outside_parent", message: "เกินช่วง", details: { confirmable: true, confirmField: "extendParent", parentKey: "DE-1" } } }, { status: 422 });
        return HttpResponse.json({ version: 4 });
      }),
    );
    return bodies;
  }

  it("ยืนยันแล้วส่งคำขอเดิมซ้ำพร้อมช่องยืนยัน", async () => {
    const bodies = confirmServer();
    const ask = vi.fn().mockResolvedValue(true);
    setConfirmHandler(ask);
    try {
      expect(await new ApiClient().patch("/issues/DE-2", { planEnd: "2026-12-20" }, 3)).toEqual({ version: 4 });
      expect(ask).toHaveBeenCalledWith(expect.objectContaining({ code: "subtask_outside_parent", details: expect.objectContaining({ parentKey: "DE-1" }) }));
      expect(bodies).toEqual([{ planEnd: "2026-12-20" }, { planEnd: "2026-12-20", extendParent: true }]);
    } finally { setConfirmHandler(null); }
  });

  it("ยกเลิกแล้วไม่ส่งซ้ำ และได้ error confirm_cancelled", async () => {
    const bodies = confirmServer();
    setConfirmHandler(vi.fn().mockResolvedValue(false));
    try {
      await expect(new ApiClient().patch("/issues/DE-2", { planEnd: "2026-12-20" }, 3)).rejects.toMatchObject({ code: "confirm_cancelled" });
      expect(bodies).toHaveLength(1);
    } finally { setConfirmHandler(null); }
  });

  it("ไม่มีกล่องยืนยัน = ส่ง error 422 ให้ผู้เรียกตามเดิม", async () => {
    confirmServer();
    await expect(new ApiClient().patch("/issues/DE-2", { planEnd: "2026-12-20" }, 3)).rejects.toMatchObject({ status: 422, code: "subtask_outside_parent" });
  });
});

