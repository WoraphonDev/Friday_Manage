// Q2 · เมื่อใช้เกินสิทธิ์แพ็กเกจ (7 สถานการณ์)
// - ทีมโตเกินแพ็กเกจ / ทดลองใช้ใกล้หมด / ค้างชำระ → UsageBanner (อ่าน GET usage)
// - Free ครบ 3 โปรเจกต์ / พื้นที่ไฟล์เต็ม / เชิญเกินจำนวน → PlanLimitDialog จาก 402 (PlanLimitHost ฟังจาก API client)
// - ฟีเจอร์ของแพ็กเกจเสียเงิน → FeatureLock · Automation ครบโควตา → AutomationQuotaBanner
export { PlanLimitDialog, PlanLimitHost, RequestUpgradeButton } from "./PlanLimitDialog";
export { AutomationQuotaBanner, FeatureLock, LegalUpdateBanner, UsageBanner, WorkspaceBanners } from "./Banners";
export * from "./types";
