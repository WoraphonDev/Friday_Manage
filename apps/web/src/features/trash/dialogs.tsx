"use client";

import { useContext, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Dialog, Input, YearFormatContext } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { purgeItems, restoreProject } from "./api";
import { roleText } from "./format";
import { KEY_RE, PURGE_WORD, type TrashItem, type TrashProject, type TrashType } from "./types";
import styles from "./trash.module.css";

/** Key แรกที่ลองเสนอเอง (ตรงกับตัวแรกที่ API แนะนำ: MKT → MKT2) · API ตอบ suggestedKey จริงเมื่อชน */
const localSuggestion = (key: string) => `${key.slice(0, 9)}2`;

/**
 * Z2 · กู้คืนโปรเจกต์ · Key ถูกใช้แล้ว (409 project_key_taken / key_taken) ให้เลือก Key ใหม่
 * เกินแพ็กเกจ (402) ปิด Dialog นี้ ให้ PlanLimitHost กลางแสดง Q2 แทน (ไม่กู้บางส่วน)
 */
export function RestoreProjectDialog({
  ws,
  item,
  onClose,
  onRestored,
}: {
  ws: string;
  item: TrashProject;
  onClose: () => void;
  onRestored: (key: string) => void;
}) {
  const t = useTranslations("trash");
  const year = useContext(YearFormatContext);
  const [taken, setTaken] = useState<{ key: string; name: string | null } | null>(item.keyTaken);
  const [newKey, setNewKey] = useState(item.keyTaken ? localSuggestion(item.key) : "");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const keyValid = !taken || KEY_RE.test(newKey);
  const by = item.deletedBy ? `${item.deletedBy.displayName}${roleText(t, item.deletedBy.role)}` : null;
  const at = formatDate(item.deletedAt, year, true);
  const purge = formatDate(item.purgeAt, year, true);

  async function submit() {
    if (!keyValid) return;
    setPending(true);
    setError("");
    try {
      const r = await restoreProject(ws, item.id, taken ? newKey : undefined);
      onRestored(r.key);
    } catch (e) {
      if (e instanceof ApiError && (e.code === "project_key_taken" || e.code === "key_taken")) {
        const takenBy = e.details.takenBy as { key: string; name: string | null } | undefined;
        setTaken(takenBy ?? { key: String(e.details.key ?? item.key), name: null });
        if (typeof e.details.suggestedKey === "string") setNewKey(e.details.suggestedKey);
        if (e.code === "key_taken") setError(e.message);
      } else if (e instanceof ApiError && e.status === 402) {
        // Dialog Q2 กลาง (PlanLimitHost) เปิดจาก event ของ API client แล้ว
        onClose();
      } else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()} title={t("rp.title", { key: item.key, name: item.name })} description={by ? t("rp.by", { by, at, purge }) : t("rp.byUnknown", { at, purge })}>
      <div className={styles.form}>
        <div className={styles.facts}>
          <div className={styles.fact}>
            <span>{t("rp.back")}</span>
            <span>{t("rp.backValue", item.counts)}</span>
          </div>
          <div className={styles.fact}>
            <span>{t("rp.members")}</span>
            <span>{t("rp.membersValue")}</span>
          </div>
          <div className={styles.fact}>
            <span>{t("rp.notify")}</span>
            <span>{t("rp.notifyValue")}</span>
          </div>
        </div>
        {taken && (
          <>
            <div className={styles.warnBox} role="status">
              <b>{taken.name ? t("rp.takenBy", { key: taken.key, name: taken.name }) : t("rp.taken", { key: taken.key })}</b>
              <span>{t("rp.takenHint", { key: item.key })}</span>
            </div>
            <Input
              label={`${t("rp.newKey")} *`}
              value={newKey}
              onChange={(e) => {
                setNewKey(e.target.value.toUpperCase().replace(/\s/g, ""));
                setError("");
              }}
              className={styles.mono}
              maxLength={10}
              autoComplete="off"
              error={newKey && !KEY_RE.test(newKey) ? t("rp.keyInvalid") : error || undefined}
              hint={t("rp.keyHint")}
            />
          </>
        )}
        {!taken && error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className={styles.foot}>
          <span className={styles.muted}>{t("rp.audit")}</span>
          <div className={styles.actions}>
            <Button disabled={pending} onClick={onClose}>
              {t("rp.cancel")}
            </Button>
            <Button variant="primary" disabled={pending || !keyValid} onClick={() => void submit()}>
              {t("rp.submit")}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** Z3 · ลบถาวร (ระดับ 3 ของ P3 · พิมพ์ "ลบถาวร") · Owner เท่านั้น (API ตรวจซ้ำ) */
export function PurgeDialog({
  ws,
  type,
  items,
  onClose,
  onPurged,
}: {
  ws: string;
  type: TrashType;
  items: TrashItem[];
  onClose: () => void;
  onPurged: (n: number) => void;
}) {
  const t = useTranslations("trash");
  const [word, setWord] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const labels = items.map((i) => (i.type === "file" ? i.name : i.key));
  const subtasks = items.reduce((n, i) => n + (i.type === "issue" ? i.subtasks : 0), 0);
  const shown = labels.slice(0, 6).join(", ") + (labels.length > 6 ? " …" : "");

  async function submit() {
    setPending(true);
    setError("");
    try {
      const r = await purgeItems(ws, type, items.map((i) => i.id), word.trim());
      onPurged(r.purged);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      title={type === "issue" ? t("pd.titleIssues", { n: items.length }) : t("pd.title", { n: items.length })}
      description={subtasks ? `${shown} ${t("pd.withSubtasks", { n: subtasks })}` : shown}
    >
      <div className={styles.form}>
        <div className={styles.dangerBox} role="note">
          {t("pd.warn")}
        </div>
        <Input label={`${t("pd.type", { word: PURGE_WORD })} *`} value={word} onChange={(e) => setWord(e.target.value)} autoComplete="off" error={error || undefined} />
        <div className={styles.foot}>
          <span className={styles.muted}>{t("pd.ownerOnly")}</span>
          <div className={styles.actions}>
            <Button disabled={pending} onClick={onClose}>
              {t("pd.cancel")}
            </Button>
            <Button variant="danger" disabled={pending || word.trim() !== PURGE_WORD} onClick={() => void submit()}>
              {t("pd.submit")}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

