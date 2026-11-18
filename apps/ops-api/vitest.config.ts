import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Nest ต้องใช้ decorator metadata ซึ่ง esbuild ไม่สร้างให้ จึงใช้ SWC
  plugins: [swc.vite({ module: { type: 'es6' } })],
  // ข้อมูลสมมติใช้ *.example.com เป็นลูกค้า · ปิดกฎ Workspace ทดสอบอัตโนมัติ (เทสต์ของกฎตั้งค่าเอง)
  test: { fileParallelism: false, testTimeout: 20000, env: { OPS_TEST_EMAIL_DOMAINS: '' } },
});
