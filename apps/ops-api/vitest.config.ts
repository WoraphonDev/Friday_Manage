import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Nest ต้องใช้ decorator metadata ซึ่ง esbuild ไม่สร้างให้ จึงใช้ SWC
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: { fileParallelism: false, testTimeout: 20000 },
});
