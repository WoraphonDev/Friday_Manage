"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Modal } from "@/components/kit";
import { Button, InlineError, Input, Select, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useSupportStaff } from "@/lib/staff-options";
import { type Account, ACCOUNTS_KEY } from "./types";

/** สร้างบัญชีลูกค้าจากผู้ซื้อที่ระบบเสนอ (หรือจากหน้า Workspaces) · คนยืนยันชื่อ เลขภาษี ผู้ดูแล ก่อนสร้าง */
export function CreateAccountDialog({ name: initialName, taxIds: initialTax, workspaces, onClose }: { name: string; taxIds: string[]; workspaces: { id: string; name: string }[]; onClose: () => void }) {
  const t = useTranslations("customers.accounts.create");
  const tk = useTranslations("customers.accounts.kind");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const router = useRouter();
  const cache = useQueryClient();
  const staff = useSupportStaff();
  const [name, setName] = useState(initialName);
  const [tax, setTax] = useState(initialTax.join(", "));
  const [managerId, setManagerId] = useState("");
  const [kind, setKind] = useState<"standard" | "enterprise">("standard");
  const m = useMutation({
    mutationFn: () =>
      api.post<Account>("/accounts", {
        name: name.trim(),
        taxIds: tax.split(/[,\s]+/).map((x) => x.replace(/\D/g, "")).filter(Boolean),
        ...(managerId ? { managerId } : {}),
        kind,
        workspaceIds: workspaces.map((w) => w.id),
      }),
    onSuccess: (a) => {
      void cache.invalidateQueries({ queryKey: ACCOUNTS_KEY });
      void cache.invalidateQueries({ queryKey: ["ops", "workspaces"] });
      toast(t("done", { name: a.name }));
      router.push(`/accounts/${a.id}`);
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title")} description={t("desc", { n: workspaces.length })}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), name.trim().length >= 2 && m.mutate())}>
        <Input label={t("name")} value={name} onChange={(e) => setName(e.target.value)} />
        <Input label={t("taxIds")} value={tax} inputMode="numeric" onChange={(e) => setTax(e.target.value)} />
        <Select label={t("manager")} value={managerId} onChange={(e) => setManagerId(e.target.value)}>
          <option value="">{t("none")}</option>
          {staff.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
        <Select label={t("kind")} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          {(["standard", "enterprise"] as const).map((k) => (
            <option key={k} value={k}>
              {tk(k)}
            </option>
          ))}
        </Select>
        <div>
          <span className="field-label">{t("workspaces")}</span>
          <ul className="small" style={{ margin: "4px 0 0", maxHeight: 160, overflowY: "auto" }}>
            {workspaces.map((w) => (
              <li key={w.id}>{w.name}</li>
            ))}
          </ul>
        </div>
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={name.trim().length < 2 || m.isPending}>
            {t("do")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
