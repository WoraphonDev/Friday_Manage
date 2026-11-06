import { Suspense } from "react";
import type { Metadata } from "next";
import common from "../../../messages/th/common.json";
import { LoginForm } from "./_components/login-form";

export const metadata: Metadata = { title: common.auth.login };

// useSearchParams ต้องอยู่ใต้ Suspense เพื่อให้ build แบบ static ได้
export default function Page() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
