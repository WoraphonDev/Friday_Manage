import type { Metadata } from "next";
import { notFound } from "next/navigation";
import messages from "../../../../messages/th/saas-pages.json";
import { LegalView } from "../../_components/legal";
import { isLegalType } from "../../_components/legal-types";

export async function generateMetadata({ params }: { params: Promise<{ type: string }> }): Promise<Metadata> {
  const { type } = await params;
  return { title: isLegalType(type) ? messages.legal.types[type] : messages.legal.center };
}

export default async function Page({ params }: { params: Promise<{ type: string }> }) {
  const { type } = await params;
  if (!isLegalType(type)) notFound();
  return <LegalView type={type} />;
}
