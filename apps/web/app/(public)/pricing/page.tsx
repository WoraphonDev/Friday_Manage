import type { Metadata } from "next";
import messages from "../../../messages/th/saas-pages.json";
import { PricingPage } from "../_components/landing";

export const metadata: Metadata = { title: messages.pricing.title };

export default function Page() {
  return <PricingPage />;
}
