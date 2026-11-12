"use client";

import { POSITIONS, positionLabel, toPositionCode } from "@/lib/positions";
import styles from "./position-picker.module.css";

/**
 * เลือกตำแหน่งในโปรเจกต์ได้หลายตำแหน่ง (ผู้ใช้ขอ 2026-11-13: คนหนึ่งทำได้หลายหน้าที่ เช่น SA + Dev, BA + QA)
 * ค่าที่ไม่อยู่ในชุดมาตรฐาน (ข้อมูลเดิมที่พิมพ์เอง) แสดงไว้ด้วยเพื่อเอาออกได้
 */
export function PositionPicker({ label, value, onChange }: { label: string; value: string[]; onChange: (next: string[]) => void }) {
  const codes = value.map(toPositionCode).filter(Boolean);
  const extra = codes.filter((c) => !POSITIONS.some((p) => p.code === c));
  const options = [...POSITIONS.map((p) => p.code as string), ...extra];
  const toggle = (code: string) => onChange(codes.includes(code) ? codes.filter((c) => c !== code) : [...codes, code]);
  return (
    <fieldset className={styles.box}>
      <legend className={styles.legend}>{label}</legend>
      <div className={styles.chips}>
        {options.map((code) => (
          <button key={code} type="button" className={styles.chip} aria-pressed={codes.includes(code)} title={positionLabel(code)} onClick={() => toggle(code)}>
            {positionLabel(code)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
