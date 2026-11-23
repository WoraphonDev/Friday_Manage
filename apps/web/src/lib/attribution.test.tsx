// A34 · ที่มาของผู้ใช้ (cookie fm_attr) และการนับการใช้ฟีเจอร์ · ข้อมูลสมมติเท่านั้น
import { afterEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { ATTRIBUTION_COOKIE, AttributionCapture, captureAttribution, landingFrom } from "@/lib/attribution";
import { CONSENT_CHANGED, CONSENT_KEY } from "@/lib/consent";
import { trackFeature } from "@/lib/track";
import { navigation } from "@/test/router";
import { server } from "@/test/server";

const cookieValue = () => {
  const raw = document.cookie.split("; ").find((c) => c.startsWith(`${ATTRIBUTION_COOKIE}=`));
  return raw ? JSON.parse(decodeURIComponent(raw.slice(ATTRIBUTION_COOKIE.length + 1))) : null;
};
const consent = (analytics: boolean) => {
  localStorage.setItem(CONSENT_KEY, JSON.stringify({ v: 1, necessary: true, analytics, marketing: false, at: "2026-11-20T10:00:00.000Z" }));
  window.dispatchEvent(new Event(CONSENT_CHANGED));
};
const visit = (url: string) => window.history.replaceState(null, "", url);

afterEach(() => {
  document.cookie = `${ATTRIBUTION_COOKIE}=; Max-Age=0; Path=/`;
  sessionStorage.clear();
  visit("/");
});

describe("ที่มาของการเข้าครั้งแรก", () => {
  it("อ่าน UTM จาก URL · referrer นับเฉพาะเว็บอื่น · ตัดความยาวตามที่ API รับ", () => {
    const loc = { search: `?utm_source=google&utm_medium=cpc&utm_campaign=${"x".repeat(150)}&q=secret`, pathname: "/pricing", host: "app.example.test" };
    const a = landingFrom(loc, "https://www.google.com/search?q=x", new Date("2026-11-20T03:00:00Z"));
    expect(a).toEqual({ utmSource: "google", utmMedium: "cpc", utmCampaign: "x".repeat(100), referrer: "https://www.google.com/search?q=x", landingPath: "/pricing", firstSeenAt: "2026-11-20T03:00:00.000Z" });
    expect(landingFrom(loc, "https://app.example.test/").referrer).toBeUndefined();
    expect(landingFrom(loc, "not a url").referrer).toBeUndefined();
  });

  it("ยังไม่ตอบแบนเนอร์ → ยังไม่เขียน cookie · ยินยอมคุกกี้วิเคราะห์ทีหลังแล้วได้ที่มาของหน้าแรก ไม่ใช่หน้าที่ยินยอม", () => {
    visit("/?utm_source=line&utm_campaign=launch");
    navigation.pathname = "/";
    render(<AttributionCapture />);
    expect(cookieValue()).toBeNull();
    visit("/pricing");
    consent(true);
    expect(cookieValue()).toMatchObject({ utmSource: "line", utmCampaign: "launch", landingPath: "/" });
  });

  it("มี cookie แล้วไม่ทับ (นับการเข้าครั้งแรก)", () => {
    consent(true);
    visit("/?utm_source=facebook");
    captureAttribution();
    sessionStorage.clear();
    visit("/?utm_source=tiktok");
    captureAttribution();
    expect(cookieValue()).toMatchObject({ utmSource: "facebook" });
  });

  it("ปฏิเสธ / ถอนความยินยอม → ลบ cookie และไม่จำหน้าแรก", () => {
    consent(true);
    visit("/?utm_source=google");
    captureAttribution();
    expect(cookieValue()).not.toBeNull();
    consent(false);
    captureAttribution();
    expect(cookieValue()).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("ในแอปหลังล็อกอิน (/work) ไม่เก็บ", () => {
    consent(true);
    visit("/work/sample?utm_source=google");
    navigation.pathname = "/work/sample";
    render(<AttributionCapture />);
    expect(cookieValue()).toBeNull();
  });
});

describe("feature.used", () => {
  it("ส่งชื่อฟีเจอร์อย่างเดียว · ซ้ำในวันเดียวกันไม่ส่งอีก · แยกตาม Workspace", async () => {
    const bodies: { ws: string; body: unknown }[] = [];
    server.use(
      http.post("*/api/v1/w/:ws/events", async ({ params, request }) => {
        bodies.push({ ws: String(params.ws), body: await request.json() });
        return HttpResponse.json({ accepted: 1 }, { status: 202 });
      }),
    );
    trackFeature("feat-a", "gantt");
    trackFeature("feat-a", "gantt");
    trackFeature("feat-b", "gantt");
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies).toEqual([
      { ws: "feat-a", body: { events: [{ name: "feature.used", props: { feature: "gantt" } }] } },
      { ws: "feat-b", body: { events: [{ name: "feature.used", props: { feature: "gantt" } }] } },
    ]);
  });
});
