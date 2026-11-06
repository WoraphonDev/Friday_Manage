import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { server } from "./server";
import { navigation, router } from "./router";

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
}));
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => undefined;
Element.prototype.releasePointerCapture = () => undefined;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  vi.clearAllMocks();
  navigation.pathname = "/w/sample";
  navigation.search = "";
  document.cookie = "fm_csrf=; Max-Age=0; path=/";
  localStorage.clear();
});
afterAll(() => server.close());
