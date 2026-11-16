import { defineConfig } from 'vitest/config';

// สร้าง PDF จริงด้วยฟอนต์ในเครื่อง ไม่ใช้ฐานข้อมูล
export default defineConfig({ test: { fileParallelism: false, hookTimeout: 30000, testTimeout: 20000 } });
