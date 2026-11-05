"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Dialog, Input } from "@/components/ui";

export function CommandPalette({
  workspace,
  open,
  onOpenChange,
}: {
  workspace: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const router = useRouter();
  const t = useTranslations("common");
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("features.commandTitle")}
      description={t("features.commandDescription")}
    >
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          router.push(
            `/w/${encodeURIComponent(workspace)}/search?q=${encodeURIComponent(query)}`,
          );
          onOpenChange(false);
        }}
      >
        <Input
          autoFocus
          label={t("app.search")}
          hint={t("features.commandHint")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit" variant="primary">
          {t("app.search")}
        </Button>
      </form>
    </Dialog>
  );
}
