import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { mySessionId, openSessions, staff } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, server } from "@/test/server";
import { Shell } from "../shell/Shell";
import { Support } from "./Support";

const view = () => {
  navigation.pathname = "/support";
  return renderWithProviders(
    <Shell>
      <Support />
    </Shell>,
  );
};

describe("การเข้าช่วยเหลือ", () => {
  it("รายการ session ที่เปิดอยู่ · จบ session ของคนอื่นได้เมื่อเป็น Admin", async () => {
    let ended = "";
    server.use(
      http.get(`${OPS}/support-sessions`, () => HttpResponse.json({ items: ended ? [] : openSessions(staff.support.id) })),
      http.post(`${OPS}/support-sessions/:id/end`, ({ params }) => {
        ended = String(params.id);
        return HttpResponse.json({ session: {} });
      }),
    );
    view();
    expect(await screen.findByText(/#1001 ลูกค้าแจ้งนำเข้าไฟล์ค้าง/)).toBeInTheDocument();
    expect(screen.getByText("ซัพพอร์ตตัวอย่าง")).toBeInTheDocument();
    expect(screen.getByText(/กำลังใช้ 1[0-9] นาที/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "จบ session" }));
    await waitFor(() => expect(ended).toBe(mySessionId));
    expect(await screen.findByText("ไม่มีการเข้าช่วยเหลือที่เปิดอยู่")).toBeInTheDocument();
  });

  it("Support คนอื่นไม่เห็นปุ่มจบ session ที่ไม่ใช่ของตัวเอง", async () => {
    asRole("support");
    server.use(http.get(`${OPS}/support-sessions`, () => HttpResponse.json({ items: openSessions(staff.admin.id) })));
    view();
    expect(await screen.findByText(/#1001/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "จบ session" })).not.toBeInTheDocument();
  });

  it("ไม่มี session: สถานะว่าง", async () => {
    view();
    expect(await screen.findByText("ไม่มีการเข้าช่วยเหลือที่เปิดอยู่")).toBeInTheDocument();
  });
});
