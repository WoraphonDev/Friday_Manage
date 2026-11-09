"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Info } from "lucide-react";
import {
  Avatar,
  AvatarStack,
  Badge,
  Button,
  Combobox,
  ConfirmDialog,
  ConflictState,
  DatePicker,
  Dialog,
  Drawer,
  EmptyState,
  ErrorState,
  Forbidden,
  Input,
  LoadingState,
  NotFound,
  PriorityTag,
  Select,
  Skeleton,
  StatusPill,
  Table,
  Tabs,
  Tooltip,
  useToast,
} from "@/components/ui";
import { FridayMark } from "@/components/brand/friday-logo";
import { api, ApiError } from "@/lib/api";
import type { List, Workspace } from "@/lib/types";
import { safeReturnTo } from "@/lib/utils";

export function UiGallery() {
  const t = useTranslations("common");
  const router = useRouter();
  const cache = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<string[]>([]);
  const [date, setDate] = useState("2026-12-01");
  const [tab, setTab] = useState("details");
  const [dialog, setDialog] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [child, setChild] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const people = [
    { id: "sample-one", displayName: t("dev.personOne") },
    { id: "sample-two", displayName: t("dev.personTwo") },
  ];
  async function login(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      await api.post("/auth/login", { email, password, remember: false });
      cache.clear();
      const workspaces = await api.get<List<Workspace>>("/me/workspaces");
      const returnTo = new URLSearchParams(window.location.search).get(
        "returnTo",
      );
      router.push(
        safeReturnTo(
          returnTo,
          workspaces.items[0]
            ? `/work/${workspaces.items[0].slug}`
            : "/onboarding",
        ),
      );
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : t("app.unknownError"),
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="dev-page">
      <div className="row">
        <FridayMark />
        <h1>
          {t("app.name")} · {t("dev.title")}
        </h1>
      </div>
      <p className="muted">{t("dev.description")}</p>
      <div className="dev-grid">
        <section className="card stack">
          <h2>{t("dev.buttons")}</h2>
          <div className="row">
            <Button variant="primary">{t("app.save")}</Button>
            <Button>{t("app.cancel")}</Button>
            <Button variant="danger" onClick={() => setConfirm(true)}>
              {t("app.delete")}
            </Button>
            <Button disabled>{t("app.saving")}</Button>
            <Tooltip content={t("dev.tooltip")}>
              <Button size="icon" aria-label={t("dev.tooltip")}>
                <Info size={16} />
              </Button>
            </Tooltip>
          </div>
          <Input label={t("dev.name")} placeholder={t("dev.sample")} />
          <Input label={t("dev.email")} error={t("dev.sampleError")} />
          <Select label={t("dev.unit")}>
            <option>{t("dev.md")}</option>
            <option>{t("dev.hour")}</option>
          </Select>
        </section>
        <section className="card stack">
          <h2>{t("dev.people")}</h2>
          <div className="row">
            <Avatar person={people[0]} />
            <AvatarStack people={people} max={1} />
          </div>
          <Combobox
            label={t("dev.choosePerson")}
            options={people}
            value={selected}
            onValueChange={setSelected}
            multiple
          />
          <DatePicker
            label={t("dev.dateLabel")}
            value={date}
            onValueChange={setDate}
          />
          <DatePicker
            label={`${t("dev.dateLabel")} · CE`}
            value={date}
            onValueChange={setDate}
            yearFormat="CE"
          />
        </section>
        <section className="card stack">
          <h2>{t("dev.badges")}</h2>
          <div className="row">
            {(
              ["todo", "in_progress", "review", "done", "overdue"] as const
            ).map((status) => (
              <StatusPill status={status} key={status} />
            ))}
          </div>
          <div className="row">
            {(["urgent", "high", "medium", "low"] as const).map((priority) => (
              <PriorityTag priority={priority} key={priority} />
            ))}
          </div>
          <div className="row">
            <Badge tone="blue">{t("dev.sample")}</Badge>
            <Badge tone="teal">{t("dev.sample")}</Badge>
            <Badge tone="purple">{t("dev.sample")}</Badge>
          </div>
        </section>
        <section className="card stack">
          <h2>{t("dev.overlays")}</h2>
          <div className="row">
            <Button onClick={() => setDialog(true)}>
              {t("dev.openDialog")}
            </Button>
            <Button onClick={() => setDrawer(true)}>
              {t("dev.openDrawer")}
            </Button>
            <Button onClick={() => setConfirm(true)}>{t("app.delete")}</Button>
          </div>
          <Skeleton />
          <Skeleton className="skeleton-heading" />
          <ConflictState
            onLoadLatest={() => toast({ message: t("dev.restored") })}
          />
        </section>
        <section className="card dev-wide">
          <h2>{t("dev.tables")}</h2>
          <Tabs
            value={tab}
            onValueChange={setTab}
            label={t("dev.tables")}
            items={[
              {
                value: "details",
                label: t("dev.tabOne"),
                content: (
                  <Table
                    caption={t("dev.people")}
                    rows={people}
                    rowKey={(person) => person.id}
                    columns={[
                      {
                        key: "name",
                        header: t("dev.name"),
                        render: (person) => (
                          <span className="row">
                            <Avatar person={person} />
                            {person.displayName}
                          </span>
                        ),
                      },
                      {
                        key: "status",
                        header: t("dev.badges"),
                        render: () => <StatusPill status="in_progress" />,
                      },
                    ]}
                  />
                ),
              },
              {
                value: "history",
                label: t("dev.tabTwo"),
                content: <EmptyState />,
              },
            ]}
          />
        </section>
        <section className="card">
          <LoadingState />
          <EmptyState />
        </section>
        <section className="card">
          <ErrorState
            error={
              new ApiError(
                500,
                "test",
                t("dev.sampleError"),
                {},
                "req_demo_001",
              )
            }
            retry={() => toast({ message: t("app.retry") })}
          />
          <Forbidden
            requestAccess={() => toast({ message: t("dev.request") })}
          />
          <NotFound />
        </section>
        <section className="card stack dev-wide">
          <h2>{t("dev.login")}</h2>
          <p className="muted">{t("dev.loginHelp")}</p>
          <form className="stack" onSubmit={(event) => void login(event)}>
            <Input
              label={t("auth.email")}
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Input
              label={t("auth.password")}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {error && (
              <p role="alert" className="field-error">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? t("app.saving") : t("auth.login")}
            </Button>
          </form>
        </section>
      </div>
      <Dialog
        open={dialog}
        onOpenChange={setDialog}
        title={t("dev.overlays")}
        description={t("dev.description")}
      >
        <p>{t("dev.sample")}</p>
      </Dialog>
      <Drawer
        open={drawer}
        onOpenChange={setDrawer}
        title={t("dev.parent")}
        description={t("dev.description")}
      >
        <Button onClick={() => setChild(true)}>{t("dev.openChild")}</Button>
        <Drawer
          open={child}
          onOpenChange={setChild}
          title={t("dev.child")}
          description={t("dev.description")}
          depth={2}
          parentLabel={t("dev.parent")}
        >
          <p>{t("dev.sample")}</p>
        </Drawer>
      </Drawer>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("dev.confirmTitle")}
        description={t("dev.confirmDescription")}
        confirmLabel={t("app.delete")}
        onConfirm={() => undefined}
        successMessage={t("dev.deleted")}
        undo={() => toast({ message: t("dev.restored") })}
      />
    </main>
  );
}
