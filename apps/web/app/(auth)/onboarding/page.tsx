import type { Metadata } from "next";
import common from "../../../messages/th/common.json";
import { OnboardingWizard } from "./_components/onboarding-wizard";

export const metadata: Metadata = { title: common.auth.onboarding };

export default function Page() {
  return <OnboardingWizard />;
}
