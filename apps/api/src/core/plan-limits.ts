import { Injectable } from '@nestjs/common';
import type { Tx } from '@friday/db';

/** ทรัพยากรที่แพ็กเกจจำกัด (หน้า Q2) */
export type LimitKind = 'projects' | 'seats' | 'storage_bytes';

/**
 * ตรวจขีดจำกัดของแพ็กเกจก่อนสร้างทรัพยากร · เกินตอบ 402 ตามธรรมเนียมใน 03-api
 * ตอนนี้ยังไม่จำกัด (ทุก Workspace ผ่าน) · งาน A29 (billing) ใส่การตรวจจริงที่ไฟล์นี้ไฟล์เดียว
 * จุดที่เรียกอยู่แล้ว: สร้างโปรเจกต์, เพิ่มสมาชิกที่ไม่ใช่ Guest, นำเข้า Excel เป็นโปรเจกต์ใหม่ · ไฟล์ (A11) เรียกตอนอัปโหลด
 */
@Injectable()
export class PlanLimits {
  async assert(_tx: Tx, _workspaceId: string, _kind: LimitKind, _increment = 1): Promise<void> {}
}
