"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { FridayLogo } from "@/components/brand/friday-logo";
import { Button, ErrorState, Input, LoadingState, Select, initials } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { FormAlert, Heading, NS, styles } from "../../_components/shared";

type Step = 1 | 2 | 3 | 4;
type TeamRole = "pm" | "dev" | "design" | "qa" | "other";
type Method = "scrum" | "kanban" | "waterfall";
type Start = "sample" | "new" | "import";
type InviteRole = "member" | "admin" | "guest";
interface Me {
  email: string;
  displayName: string;
}
interface Workspace {
  slug: string;
  name: string;
}
interface InviteResult {
  items: { email: string; status: "invited" | "already_member" }[];
}

const TEAM_ROLES: TeamRole[] = ["pm", "dev", "design", "qa", "other"];
const TEAM_SIZES = ["1–5", "6–15", "16–50", "50+"];
const METHODS: Method[] = ["scrum", "kanban", "waterfall"];
const STARTS: Start[] = ["sample", "new", "import"];
const STEP_KEYS = ["workspace", "team", "invite", "project"] as const;
// ตรงกับ API: a–z, 0–9 และ - ยาว 2–63 ตัว ขึ้นต้นด้วยตัวอักษรหรือตัวเลข
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function slugify(name: string) {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function useDebounced<T>(value: T, ms = 350) {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return current;
}

export function OnboardingWizard() {
  const t = useTranslations(NS);
  const router = useRouter();
  const cache = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/me") });
  const [step, setStep] = useState<Step>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ขั้นที่ 1
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  // ขั้นที่ 2 (ยังไม่มี API เก็บ · ส่ง method ต่อให้ Wizard สร้างโปรเจกต์)
  const [teamRole, setTeamRole] = useState<TeamRole>("pm");
  const [teamSize, setTeamSize] = useState(TEAM_SIZES[1]);
  const [method, setMethod] = useState<Method>("scrum");
  // ขั้นที่ 3
  const [invites, setInvites] = useState<{ email: string; role: InviteRole }[]>(() =>
    Array.from({ length: 3 }, () => ({ email: "", role: "member" as const })),
  );
  // ขั้นที่ 4
  const [start, setStart] = useState<Start>("sample");

  const debouncedSlug = useDebounced(slug);
  const slugValid = SLUG.test(debouncedSlug);
  const slugCheck = useQuery({
    queryKey: ["workspaces", "slug-available", debouncedSlug],
    queryFn: () =>
      api.get<{ slug: string; available: boolean }>(
        `/workspaces/slug-available?slug=${encodeURIComponent(debouncedSlug)}`,
      ),
    enabled: !workspace && slugValid,
    retry: false,
  });

  if (me.isPending)
    return (
      <div className={styles.obRoot}>
        <div className={styles.obPage}>
          <div className={styles.obCard}>
            <LoadingState />
          </div>
        </div>
      </div>
    );
  if (me.isError)
    return (
      <div className={styles.obRoot}>
        <div className={styles.obPage}>
          <div className={styles.obCard}>
            <ErrorState error={me.error} retry={() => me.refetch()} />
          </div>
        </div>
      </div>
    );

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  function changeName(value: string) {
    setName(value);
    if (!slugEdited) setSlug(slugify(value));
  }

  const slugState: "idle" | "checking" | "ok" | "taken" | "invalid" = !slug
    ? "idle"
    : !SLUG.test(slug)
      ? "invalid"
      : slug !== debouncedSlug || slugCheck.isFetching
        ? "checking"
        : slugCheck.data?.available === false
          ? "taken"
          : slugCheck.data?.available
            ? "ok"
            : "idle";
  const slugTaken = slugState === "taken" || (error instanceof ApiError && error.code === "slug_taken");

  async function createWorkspace() {
    if (workspace) return setStep(2);
    await act(async () => {
      const created = await api.post<Workspace>("/workspaces", { name: name.trim(), slug });
      setWorkspace(created);
      cache.removeQueries({ queryKey: ["me"] });
      setStep(2);
    });
  }

  const filled = invites.filter((row) => row.email.trim());
  const badEmails = filled.filter((row) => !EMAIL.test(row.email.trim())).map((row) => row.email.trim());

  async function sendInvites() {
    if (!workspace) return;
    if (badEmails.length) {
      setError(null);
      setNotice(null);
      return;
    }
    if (!filled.length) return setStep(4);
    await act(async () => {
      // API รับ Role เดียวต่อคำขอ จึงแยกส่งตาม Role
      const byRole = new Map<InviteRole, string[]>();
      for (const row of filled) byRole.set(row.role, [...(byRole.get(row.role) ?? []), row.email.trim().toLowerCase()]);
      const results: InviteResult["items"] = [];
      for (const [workspaceRole, emails] of byRole) {
        const result = await api.post<InviteResult>(`/w/${workspace.slug}/invitations`, { emails, workspaceRole });
        results.push(...result.items);
      }
      const invited = results.filter((item) => item.status === "invited").length;
      const already = results.filter((item) => item.status === "already_member").map((item) => item.email);
      setNotice(
        [t("onboarding.invited", { count: invited }), already.length ? t("onboarding.alreadyMember", { emails: already.join(", ") }) : ""]
          .filter(Boolean)
          .join(" · "),
      );
      setInvites(Array.from({ length: 3 }, () => ({ email: "", role: "member" as const })));
      setStep(4);
    });
  }

  async function finish() {
    if (!workspace) return;
    const base = `/w/${workspace.slug}`;
    if (start === "new") return router.push(`/work/${workspace.slug}/new-project?method=${method}`);
    if (start === "import") return router.push(`/work/${workspace.slug}/new-project/excel`);
    await act(async () => {
      const project = await api.post<{ key: string }>(`${base}/projects/sample`, {});
      router.push(`/work/${workspace.slug}/p/${project.key}`);
    });
  }

  async function logout() {
    await api.post("/auth/logout").catch(() => undefined);
    cache.clear();
    router.replace("/login");
  }

  const back = () => {
    setError(null);
    setNotice(null);
    setStep((Math.max(1, step - 1) as Step));
  };
  const skip = () => {
    setError(null);
    setNotice(null);
    setStep((step + 1) as Step);
  };

  const canNext =
    step === 1
      ? !!workspace || (!!name.trim() && slugState === "ok")
      : step === 3
        ? badEmails.length === 0
        : true;

  return (
    <div className={styles.obRoot}>
      <header className={styles.topbar}>
        <FridayLogo label={t("brand.name")} />
        <div className={cn(styles.muted, styles.small)}>
          {me.data.email} ·{" "}
          <button type="button" className={styles.linkButton} onClick={logout}>
            {t("onboarding.logout")}
          </button>
        </div>
      </header>
      <main className={styles.obPage}>
        <div
          className={styles.bar}
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={4}
          aria-valuenow={step}
          aria-label={t("onboarding.progress", { step })}
        >
          {[1, 2, 3, 4].map((n) => (
            <span key={n} data-on={step >= n} />
          ))}
        </div>
        <div className={cn(styles.muted, styles.small)} style={{ fontWeight: 600 }}>
          {t("onboarding.stepName", { step, name: t(`onboarding.steps.${STEP_KEYS[step - 1]}`) })}
        </div>
        <section className={styles.obCard}>
          {step === 1 && (
            <>
              <Heading title={t("onboarding.workspaceTitle")} subtitle={t("onboarding.workspaceSubtitle")} />
              <div className={styles.wsPreview}>
                <span className={styles.wsMark} aria-hidden="true">
                  {initials(name || workspace?.name || "W")}
                </span>
                {workspace && (
                  <FormAlert tone="success" message={t("onboarding.workspaceCreated", { name: workspace.name })} />
                )}
              </div>
              <Input
                label={t("onboarding.workspaceName")}
                className={styles.input}
                placeholder={t("onboarding.workspaceNamePlaceholder")}
                value={workspace?.name ?? name}
                readOnly={!!workspace}
                autoFocus
                onChange={(event) => changeName(event.target.value)}
              />
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="workspace-slug">
                  {t("onboarding.url")}
                </label>
                <span className={styles.prefix} data-invalid={slugTaken || slugState === "invalid"}>
                  <span>{t("onboarding.urlPrefix")}</span>
                  <input
                    id="workspace-slug"
                    aria-label={t("onboarding.slugLabel")}
                    aria-describedby="workspace-slug-status"
                    value={workspace?.slug ?? slug}
                    readOnly={!!workspace}
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={(event) => {
                      setSlugEdited(true);
                      setSlug(event.target.value.toLowerCase().trim());
                    }}
                  />
                </span>
                <span id="workspace-slug-status" aria-live="polite" className={styles.tiny}>
                  {workspace ? null : slugTaken ? (
                    <span className={styles.bad}>{t("onboarding.slugTaken")}</span>
                  ) : slugState === "invalid" ? (
                    <span className={styles.bad}>{t("onboarding.slugInvalid")}</span>
                  ) : slugState === "checking" ? (
                    <span className={styles.muted}>{t("onboarding.slugChecking")}</span>
                  ) : slugState === "ok" ? (
                    <span className={styles.ok}>{t("onboarding.slugOk")}</span>
                  ) : (
                    <span className={styles.muted}>{t("onboarding.slugHint")}</span>
                  )}
                </span>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <Heading title={t("onboarding.teamTitle")} subtitle={t("onboarding.teamSubtitle")} />
              <div className={styles.field} role="group" aria-labelledby="ob-role">
                <span id="ob-role" className={styles.fieldLabel}>
                  {t("onboarding.yourRole")}
                </span>
                <div className={styles.options}>
                  {TEAM_ROLES.map((role) => (
                    <button
                      key={role}
                      type="button"
                      className={styles.opt}
                      aria-pressed={teamRole === role}
                      onClick={() => setTeamRole(role)}
                    >
                      <b>{t(`onboarding.roles.${role}.name`)}</b>
                      <span className={cn(styles.muted, styles.tiny)}>{t(`onboarding.roles.${role}.description`)}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className={styles.field} role="group" aria-labelledby="ob-size">
                <span id="ob-size" className={styles.fieldLabel}>
                  {t("onboarding.teamSize")}
                </span>
                <div className={styles.chips}>
                  {TEAM_SIZES.map((size) => (
                    <button
                      key={size}
                      type="button"
                      className={styles.chip}
                      aria-pressed={teamSize === size}
                      onClick={() => setTeamSize(size)}
                    >
                      {size}
                    </button>
                  ))}
                </div>
              </div>
              <div className={styles.field} role="group" aria-labelledby="ob-method">
                <span id="ob-method" className={styles.fieldLabel}>
                  {t("onboarding.method")}
                </span>
                <div className={cn(styles.options, styles.optionsWide)}>
                  {METHODS.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className={styles.opt}
                      aria-pressed={method === item}
                      onClick={() => setMethod(item)}
                    >
                      <b>{t(`onboarding.methods.${item}.name`)}</b>
                      <span className={cn(styles.muted, styles.tiny)}>{t(`onboarding.methods.${item}.description`)}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <Heading title={t("onboarding.inviteTitle")} subtitle={t("onboarding.inviteSubtitle")} />
              {badEmails.length > 0 && (
                <FormAlert message={t("onboarding.invalidEmails", { emails: badEmails.join(", ") })} />
              )}
              {invites.map((row, index) => (
                <div key={index} className={styles.inviteRow}>
                  <Input
                    aria-label={t("onboarding.memberEmail", { n: index + 1 })}
                    className={styles.input}
                    type="email"
                    autoComplete="off"
                    placeholder={t("onboarding.emailPlaceholder")}
                    value={row.email}
                    aria-invalid={row.email.trim() && !EMAIL.test(row.email.trim()) ? true : undefined}
                    onChange={(event) =>
                      setInvites(invites.map((item, i) => (i === index ? { ...item, email: event.target.value } : item)))
                    }
                  />
                  <Select
                    aria-label={t("onboarding.memberRole", { n: index + 1 })}
                    value={row.role}
                    onChange={(event) =>
                      setInvites(
                        invites.map((item, i) => (i === index ? { ...item, role: event.target.value as InviteRole } : item)),
                      )
                    }
                  >
                    <option value="member">{t("join.roles.member")}</option>
                    <option value="admin">{t("join.roles.admin")}</option>
                    <option value="guest">{t("join.roles.guest")}</option>
                  </Select>
                </div>
              ))}
              <button
                type="button"
                className={cn(styles.linkButton, styles.backLink)}
                style={{ fontWeight: 600 }}
                onClick={() => setInvites([...invites, { email: "", role: "member" }])}
              >
                {t("onboarding.addMore")}
              </button>
            </>
          )}

          {step === 4 && (
            <>
              <Heading title={t("onboarding.projectTitle")} subtitle={t("onboarding.projectSubtitle")} />
              {notice && <FormAlert tone="success" message={notice} />}
              <div className={cn(styles.options, styles.optionsStart)}>
                {STARTS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={styles.opt}
                    aria-pressed={start === item}
                    onClick={() => setStart(item)}
                  >
                    <b>{t(`onboarding.starts.${item}.name`)}</b>
                    <span className={cn(styles.muted, styles.small)}>{t(`onboarding.starts.${item}.description`)}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {!!error && (
            <FormAlert error={error} message={slugTaken && step === 1 ? t("onboarding.slugTaken") : undefined} />
          )}

          <div className={styles.actions}>
            {step > 1 && (
              <Button className={styles.button} onClick={back} disabled={busy}>
                {t("onboarding.back")}
              </Button>
            )}
            <span className={styles.spacer} />
            {(step === 2 || step === 3) && (
              <button type="button" className={styles.linkMuted} onClick={skip} disabled={busy}>
                {t("onboarding.skip")}
              </button>
            )}
            {step < 4 ? (
              <Button
                variant="primary"
                className={styles.button}
                disabled={busy || !canNext}
                onClick={step === 1 ? createWorkspace : step === 3 ? sendInvites : () => setStep(3)}
              >
                {busy ? t("common.working") : step === 3 && filled.length ? t("onboarding.sendInvites") : t("onboarding.next")}
              </Button>
            ) : (
              <Button variant="primary" className={styles.button} disabled={busy} onClick={finish}>
                {busy ? t("common.working") : t(`onboarding.finish.${start}`)}
              </Button>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
