import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { navigation, router } from "./router";
import { server } from "./server";

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
}));
// Security key จริงใช้ใน jsdom ไม่ได้ · แต่ละ test กำหนดผลของ startRegistration / startAuthentication เอง
vi.mock("@simplewebauthn/browser", () => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
  browserSupportsWebAuthn: vi.fn(() => true),
}));

// หน้าต่างดูสลิปแสดงไฟล์ผ่าน blob: · เผื่อสภาพแวดล้อมที่ไม่มี object URL
if (!URL.createObjectURL) Object.assign(URL, { createObjectURL: () => "blob:test", revokeObjectURL: () => undefined });

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  vi.clearAllMocks();
  navigation.pathname = "/";
  navigation.search = "";
});
afterAll(() => server.close());
