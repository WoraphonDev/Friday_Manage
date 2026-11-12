"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { hasAny } from "@/components/access";
import { PageHead, Seg, Tabs } from "@/components/kit";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { ChangelogTab } from "./_parts/ChangelogTab";
import { EntryDrawer } from "./_parts/EntryDrawer";
import { NpsTab } from "./_parts/NpsTab";
import { SettingsDialog } from "./_parts/SettingsDialog";
import { type ChangelogData, CHANGELOG_KEY, type Entry, NPS_KEY, type NpsSummary, type Range } from "./_parts/types";
import styles from "./changelog.module.css";

type Tab = "changelog" | "nps";
export type EditorState = { kind: "create" } | { kind: "edit"; entry: Entry } | null;

/**
 * Changelog และ NPS (O33 · บอร์ด 17) · เมนู แพ็กเกจและการตลาด
 * ทุกบทบาทอ่าน Changelog · Owner เขียน / เผยแพร่ / ซ่อน / ตั้งค่าแบบสำรวจ
 * NPS: ตัวเลขรวมสำหรับ Owner / Support / การเงิน / ผู้ตรวจ · ความเห็นและการติดตามเฉพาะ Owner / Support · วิศวกรไม่เห็นแท็บ NPS
 */
export function ChangelogPage() {
  const t = useTranslations("cl");
  const me = useMe().data;
  const params = useSearchParams();
  const canWrite = hasAny(me, "owner");
  const seesNps = hasAny(me, "owner", "support", "finance", "auditor");
  const seesComments = hasAny(me, "owner", "support");
  const [tab, setTab] = useState<Tab>(params.get("tab") === "nps" ? "nps" : "changelog");
  const [range, setRange] = useState<Range>("90d");
  const [editor, setEditor] = useState<EditorState>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const list = useQuery({ queryKey: CHANGELOG_KEY, queryFn: () => api.get<ChangelogData>("/changelog"), enabled: !!me });
  // NPS 90 วันบนการ์ด KPI และตัวเลขบนแท็บ · ช่วงที่เลือกในแท็บ NPS ใช้ query แยก
  const nps90 = useQuery({ queryKey: [...NPS_KEY, "summary", "90d"], queryFn: () => api.get<NpsSummary>("/nps/summary?range=90d"), enabled: !!me && seesNps });
  const activeTab: Tab = tab === "nps" && seesNps ? "nps" : "changelog";
  const write = canWrite && (
    <Button variant="primary" onClick={() => setEditor({ kind: "create" })}>
      <Plus size={16} /> {t("write")}
    </Button>
  );
  const settings = canWrite && <Button onClick={() => setSettingsOpen(true)}>{t("settings")}</Button>;
  const cancelLink = (chunks: ReactNode) => <Link href="/business">{chunks}</Link>;
  const npsCount = nps90.data?.answered;
  return (
    <>
      {activeTab === "changelog" ? (
        <PageHead
          title={t("title")}
          desc={t.rich("desc", { link: cancelLink })}
          actions={
            <>
              {settings}
              {write}
            </>
          }
        />
      ) : (
        <PageHead
          title={t("title")}
          desc={t("npsDesc", { range: t(`range.${range}`) })}
          actions={
            <>
              <Seg label={t("range.label")} value={range} onChange={setRange} options={(["30d", "90d", "12m"] as const).map((v) => ({ value: v, label: t(`range.${v}`) }))} />
              <Button onClick={() => setExporting(true)}>{t("export")}</Button>
              {settings}
            </>
          }
        />
      )}
      <div className={styles.tabsRow}>
        <Tabs
          label={t("tabs.label")}
          value={activeTab}
          onChange={setTab}
          tabs={[
            { value: "changelog" as const, label: <>{t("tabs.changelog")} {list.data && <span className={styles.count}>{list.data.items.length}</span>}</> },
            ...(seesNps ? [{ value: "nps" as const, label: <>{t("tabs.nps")} {npsCount !== undefined && <span className={styles.count}>{npsCount}</span>}</> }] : []),
          ]}
        />
        {seesNps && (
          <Link className={styles.tabLink} href="/business">
            {t("tabs.cancel")}
          </Link>
        )}
      </div>
      {activeTab === "changelog" ? (
        <ChangelogTab query={list} nps={seesNps ? (nps90.data ?? null) : undefined} canWrite={canWrite} onEdit={(entry) => setEditor({ kind: "edit", entry })} write={write || null} />
      ) : (
        <NpsTab range={range} seesComments={seesComments} exporting={exporting} onExportingChange={setExporting} />
      )}
      {editor && <EntryDrawer key={editor.kind === "edit" ? editor.entry.id : "create"} entry={editor.kind === "edit" ? editor.entry : null} entries={list.data?.items ?? []} canWrite={canWrite} onClose={() => setEditor(null)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
