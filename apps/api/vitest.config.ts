import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Nest ต้องใช้ decorator metadata ซึ่ง esbuild ไม่สร้างให้ จึงใช้ SWC
  plugins: [swc.vite({ module: { type: 'es6' } })],
  // beforeAll ของ e2e ทำงานมากกว่า test เดี่ยว (ล้างทุกตาราง + เปิดแอป + seedTeam + hash รหัสผ่าน)
  // ค่าเริ่มต้น 10 วินาทีจึงหมดก่อนได้ตอนเครื่องรับงานอื่นหนัก ๆ (เคยล้มทั้งไฟล์ overview.e2e ในเครื่อง 23 พ.ย.)
  test: { fileParallelism: false, testTimeout: 20000, hookTimeout: 30000 },
});
