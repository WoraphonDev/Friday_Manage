import { defineConfig } from 'vitest/config';

// แต่ละไฟล์ใช้ฐานข้อมูลจริงและเตรียมข้อมูลใหม่ จึงห้ามรันพร้อมกัน
export default defineConfig({ test: { fileParallelism: false, hookTimeout: 30000, testTimeout: 20000 } });
