"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Ban, CircleCheck, LockKeyhole } from "lucide-react";
import { Button, ErrorState, Input, LoadingState, NotFound, initials } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  CardLayout,
  FormAlert,
  NS,
  OAuthLink,
  PasswordField,
  PasswordStrength,
  checkPassword,
  styles,
} from "../../../_components/shared";

type Role = "owner" | "admin" | "member" | "guest" | "viewer";
interface Invitation {
  status: "pending" | "accepted" | "declined" | "expired" | "revoked";
  email: string;
  workspace: { name: string; slug: string };
  invitedBy: string;
  workspaceRole: Role;
  project: { key: string; name: string } | null;
  projectRole: Role | null;
  message: string | null;
  expiresAt: string;
}
interface Me {
  id: string;
  email: string;
  displayName: string;
}

const DAY = 86_400_000;

export function JoinInvite({ token }: { token: string }) {
  const t = useTranslations(NS);
  const router = useRouter();
  const cache = useQueryClient();
  const path = `/join/${encodeURIComponent(token)}`;
  const invite = useQuery({
    queryKey: ["invitation", token],
    queryFn: () => api.get<Invitation>(`/invitations/${encodeURIComponent(token)}`),
    retry: false,
  });
  // หน้านี้เปิดได้โดยไม่ล็อกอิน · 401 = ผู้ใช้ใหม่ ไม่ต้องพาไปหน้า Login
  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await api.get<Me>("/me", { redirectOnUnauthorized: false });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    retry: false,
  });
  const [outcome, setOutcome] = useState<"expired" | "declined" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [accept, setAccept] = useState(false);

  if (invite.isPending || me.isPending)
    return (
      <CardLayout wide>
        <div className={styles.cardSection}>
          <LoadingState />
        </div>
      </CardLayout>
    );
  if (invite.isError) {
    const notFound = invite.error instanceof ApiError && invite.error.status === 404;
    return (
      <CardLayout wide>
        <div className={styles.cardSection}>
          {notFound ? <NotFound /> : <ErrorState error={invite.error} retry={() => invite.refetch()} />}
          {notFound && (
            <p className={cn(styles.muted, styles.center)}>{t("join.notFoundDescription")}</p>
          )}
        </div>
      </CardLayout>
    );
  }
  if (me.isError)
    return (
      <CardLayout wide>
        <div className={styles.cardSection}>
          <ErrorState error={me.error} retry={() => me.refetch()} />
        </div>
      </CardLayout>
    );

  const inv = invite.data;
  const user = me.data;
  const expired = outcome === "expired" || inv.status === "expired" || inv.status === "revoked";
  const loginHref = `/login?returnTo=${encodeURIComponent(path)}`;

  async function joinWorkspace() {
    const result = await api.post<{ workspace: { slug: string } }>(`/invitations/${encodeURIComponent(token)}/accept`);
    cache.removeQueries({ queryKey: ["me"] });
    router.replace(`/w/${result.workspace.slug}`);
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      if (err instanceof ApiError && err.code === "invitation_expired") setOutcome("expired");
      setError(err);
      setBusy(false);
    }
  }

  async function signupAndJoin(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      await api.post("/auth/signup", {
        email: inv.email,
        password,
        displayName: displayName.trim(),
        acceptTerms: true,
      });
      await joinWorkspace();
    });
  }

  async function decline() {
    await run(async () => {
      await api.post(`/invitations/${encodeURIComponent(token)}/decline`);
      setOutcome("declined");
      setBusy(false);
    });
  }

  async function switchAccount() {
    await run(async () => {
      await api.post("/auth/logout");
      cache.clear();
      router.replace(loginHref);
    });
  }

  const days = Math.max(0, Math.ceil((new Date(inv.expiresAt).getTime() - Date.now()) / DAY));
  const header = (
    <div className={styles.cardHead}>
      <div className={styles.inviteAvatars} aria-hidden="true">
        <span className={styles.avatarRound}>{initials(inv.invitedBy)}</span>
        <span className={styles.avatarSquare}>{initials(inv.workspace.name)}</span>
      </div>
      {expired ? (
        <>
          <h1>{t("join.expiredTitle")}</h1>
          <div className={styles.muted}>
            {inv.expiresAt
              ? t("join.expiredDescription", {
                  workspace: inv.workspace.name,
                  date: formatDate(inv.expiresAt, "BE", true),
                })
              : t("join.expiredDescriptionNoDate", { workspace: inv.workspace.name })}
          </div>
        </>
      ) : (
        <>
          <h1>{t("join.title", { inviter: inv.invitedBy, workspace: inv.workspace.name })}</h1>
          <div className={styles.pills}>
            <span className={cn(styles.pill, styles.pillGreen)}>{t(`join.roles.${inv.workspaceRole}`)}</span>
            {inv.project && (
              <span className={cn(styles.pill, styles.pillSlate)}>
                {t("join.projectRole", {
                  project: inv.project.name,
                  role: t(`join.roles.${inv.projectRole ?? "member"}`),
                })}
              </span>
            )}
          </div>
          {inv.message && (
            <blockquote className={styles.quote} style={{ margin: 0 }}>
              “{inv.message}” <span className={styles.muted}>— {inv.invitedBy}</span>
            </blockquote>
          )}
          {inv.status === "pending" && (
            <div className={cn(styles.muted, styles.tiny)}>{t("join.sentTo", { email: inv.email, days })}</div>
          )}
        </>
      )}
    </div>
  );
  const footer = (
    <div className={cn(styles.muted, styles.tiny, styles.footNote)}>
      {t("join.footer", { inviter: inv.invitedBy })}
    </div>
  );

  let body;
  if (expired) {
    body = (
      <>
        <div className={cn(styles.muted, styles.small, styles.center)}>
          {t.rich("join.askNew", {
            inviter: inv.invitedBy,
            login: (chunks) => <Link href="/login">{chunks}</Link>,
          })}
        </div>
      </>
    );
  } else if (outcome === "declined" || inv.status === "declined") {
    body = (
      <>
        <span className={cn(styles.icon, styles.iconBlue)} style={{ alignSelf: "center" }}>
          <Ban size={26} aria-hidden="true" />
        </span>
        <div className={styles.center}>
          <div className={styles.sectionTitle}>{t("join.declinedTitle")}</div>
          <div className={cn(styles.muted, styles.small)}>{t("join.declinedDescription", { inviter: inv.invitedBy })}</div>
        </div>
      </>
    );
  } else if (inv.status === "accepted") {
    body = (
      <>
        <span className={cn(styles.icon, styles.iconGreen)} style={{ alignSelf: "center" }}>
          <CircleCheck size={26} aria-hidden="true" />
        </span>
        <div className={styles.center}>
          <div className={styles.sectionTitle}>{t("join.usedTitle")}</div>
          <div className={cn(styles.muted, styles.small)}>{t("join.usedDescription")}</div>
        </div>
        <Link href={user ? `/w/${inv.workspace.slug}` : loginHref} className={cn("button button-primary", styles.button)}>
          {user ? t("join.joinWorkspace", { workspace: inv.workspace.name }) : t("join.login")}
        </Link>
      </>
    );
  } else if (user && user.email.toLowerCase() !== inv.email.toLowerCase()) {
    // 403: คำเชิญผูกกับอีเมล · บัญชีอื่นตอบรับไม่ได้
    body = (
      <>
        <span className={cn(styles.icon, styles.iconRed)} style={{ alignSelf: "center" }}>
          <LockKeyhole size={26} aria-hidden="true" />
        </span>
        <div className={styles.center}>
          <div className={styles.sectionTitle}>{t("join.mismatchTitle")}</div>
          <div className={cn(styles.muted, styles.small)}>
            {t("join.mismatch", { current: user.email, invited: inv.email })}
          </div>
        </div>
        {!!error && <FormAlert error={error} />}
        <Button variant="primary" className={styles.button} disabled={busy} onClick={switchAccount}>
          {t("join.switchAccount")}
        </Button>
      </>
    );
  } else if (user) {
    body = (
      <>
        <div className={styles.person}>
          <span className={styles.personAvatar} aria-hidden="true">
            {initials(user.displayName)}
          </span>
          <div>
            <div style={{ fontWeight: 600 }}>{user.displayName}</div>
            <div className={cn(styles.muted, styles.small)}>{t("join.loggedIn", { email: user.email })}</div>
          </div>
        </div>
        <div className={cn(styles.muted, styles.small)}>{t("join.existingHint")}</div>
        {!!error && <FormAlert error={error} />}
        <Button variant="primary" className={styles.button} disabled={busy} onClick={() => run(joinWorkspace)}>
          {busy ? t("common.working") : t("join.joinWorkspace", { workspace: inv.workspace.name })}
        </Button>
        <button type="button" className={cn(styles.linkButton, styles.small)} style={{ textAlign: "center" }} onClick={switchAccount}>
          {t("join.notYou")}
        </button>
        <button type="button" className={cn(styles.linkMuted, styles.small)} disabled={busy} onClick={decline}>
          {t("join.decline")}
        </button>
      </>
    );
  } else {
    const emailTaken = error instanceof ApiError && error.code === "email_taken";
    const ready = displayName.trim() && checkPassword(password).valid && accept;
    body = (
      <form className={styles.form} style={{ gap: 14 }} onSubmit={signupAndJoin} noValidate>
        <div className={styles.sectionTitle}>{t("join.newTitle")}</div>
        {!!error && (
          <FormAlert error={error}>
            {emailTaken && <Link href={loginHref}>{t("join.loginToAccept")}</Link>}
          </FormAlert>
        )}
        <Input label={t("common.email")} className={styles.input} type="email" value={inv.email} readOnly hint={t("join.emailLocked")} />
        <Input
          label={t("join.displayName")}
          className={styles.input}
          placeholder={t("join.displayNamePlaceholder")}
          autoComplete="nickname"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <div className={styles.field}>
          <PasswordField
            label={t("common.password")}
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            placeholder={t("join.passwordPlaceholder")}
          />
          {password && <PasswordStrength value={password} showMeter={false} />}
        </div>
        <label className={cn(styles.check, styles.small)}>
          <input type="checkbox" checked={accept} onChange={(event) => setAccept(event.target.checked)} />
          <span>
            {t.rich("signup.acceptTerms", {
              terms: (chunks) => (
                <Link href="/legal/terms" target="_blank">
                  {chunks}
                </Link>
              ),
              privacy: (chunks) => (
                <Link href="/legal/privacy" target="_blank">
                  {chunks}
                </Link>
              ),
            })}
          </span>
        </label>
        <Button type="submit" variant="primary" className={styles.button} disabled={busy || !ready}>
          {busy ? t("common.working") : t("join.accept")}
        </Button>
        <OAuthLink provider="google" label={t("join.acceptGoogle")} next={path} />
        <div className={cn(styles.muted, styles.small, styles.center)}>
          {t("join.haveAccount")} <Link href={loginHref}>{t("join.loginToAccept")}</Link>
        </div>
      </form>
    );
  }

  return (
    <CardLayout wide footer={footer}>
      {header}
      <div className={styles.cardSection}>{body}</div>
    </CardLayout>
  );
}
