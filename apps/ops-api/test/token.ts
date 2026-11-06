import { sign } from '../src/auth/tokens.js';
/** ออกโทเค็นเซ็นด้วยความลับเดียวกับแอป (สำหรับทดสอบ purpose ผิด / หมดอายุ) */
export const signToken = (purpose: string, payload: Record<string, unknown>, ttlSeconds: number) => sign(purpose, payload, ttlSeconds);
