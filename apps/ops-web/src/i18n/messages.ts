import abuse from "../../messages/th/abuse.json";
import ratelimit from "../../messages/th/ratelimit.json";
import jit from "../../messages/th/jit.json";
import success from "../../messages/th/success.json";
import leads from "../../messages/th/leads.json";
import quotes from "../../messages/th/quotes.json";
import scripts from "../../messages/th/scripts.json";
import announcements from "../../messages/th/announcements.json";
import changelog from "../../messages/th/changelog.json";
import bugs from "../../messages/th/bugs.json";
import common from "../../messages/th/common.json";
import customers from "../../messages/th/customers.json";
import deliveries from "../../messages/th/deliveries.json";
import entitlements from "../../messages/th/entitlements.json";
import help from "../../messages/th/help.json";
import mobile from "../../messages/th/mobile.json";
import onboarding from "../../messages/th/onboarding.json";
import money from "../../messages/th/money.json";
import ops from "../../messages/th/ops.json";
import overviewBusiness from "../../messages/th/overview-business.json";
import privacyLegal from "../../messages/th/privacy-legal.json";
import promotions from "../../messages/th/promotions.json";
import restore from "../../messages/th/restore.json";
import staff from "../../messages/th/staff.json";
import supportSettings from "../../messages/th/support-settings.json";
import supportSystem from "../../messages/th/support-system.json";

// namespace: `cl` (Changelog และ NPS · O33) · `promo` (แพ็กเกจและโปรโมชัน · O20) · `ann` (ประกาศถึงลูกค้า · O24) · `onb` (Onboarding checklist · O34) · `ops` (หน้าเดิมของ A32 ที่ O11–O15 จะย้าย) · `common` (โครงหน้า สถานะ Modal กลาง · O10) · `staff` (หน้าพนักงาน · O10) · `rst` (กู้คืนข้อมูลลูกค้า · O31) · `help` (บทความช่วยเหลือ · O35) · `bugs` (ส่งบั๊กให้ทีมพัฒนา · O36) · `abuse` (ตรวจจับการใช้ผิด · O50) · `rl` (Rate limit ต่อลูกค้า · O51) · `jit` (ขอสิทธิ์ชั่วคราว · O52) · `success` (สุขภาพและ Playbook · O53) · `leads` (Lead และดีล · O54) · `quotes` (ใบเสนอราคาและสัญญา · O55) · `scripts` (สคริปต์ดูแลข้อมูล · O56)
export const messages = { ops, common, staff, customers, money, ss: supportSystem, pl: privacyLegal, ob: overviewBusiness, ent: entitlements, dlv: deliveries, sset: supportSettings, mob: mobile, ann: announcements, promo: promotions, cl: changelog, onb: onboarding, rst: restore, help, bugs, abuse, rl: ratelimit, jit, success, leads, quotes, scripts };
