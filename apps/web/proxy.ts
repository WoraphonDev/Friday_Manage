import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  // ตรวจ session จริงซ้ำผ่าน GET /me; cookie check นี้ช่วยพาไป Login ก่อน render shell
  if (!request.cookies.get("fm_session")?.value) {
    const login = new URL("/login", request.url);
    login.searchParams.set(
      "returnTo",
      request.nextUrl.pathname + request.nextUrl.search,
    );
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/w/:path*"] };
