import announcements from "../../messages/th/announcements.json";
import changelog from "../../messages/th/changelog.json";
import common from "../../messages/th/common.json";
import customers from "../../messages/th/customers.json";
import deliveries from "../../messages/th/deliveries.json";
import entitlements from "../../messages/th/entitlements.json";
import mobile from "../../messages/th/mobile.json";
import money from "../../messages/th/money.json";
import ops from "../../messages/th/ops.json";
import overviewBusiness from "../../messages/th/overview-business.json";
import privacyLegal from "../../messages/th/privacy-legal.json";
import promotions from "../../messages/th/promotions.json";
import staff from "../../messages/th/staff.json";
import supportSettings from "../../messages/th/support-settings.json";
import supportSystem from "../../messages/th/support-system.json";

// namespace: `cl` (Changelog และ NPS · O33) · `promo` (แพ็กเกจและโปรโมชัน · O20) · `ann` (ประกาศถึงลูกค้า · O24) · `ops` (หน้าเดิมของ A32 ที่ O11–O15 จะย้าย) · `common` (โครงหน้า สถานะ Modal กลาง · O10) · `staff` (หน้าพนักงาน · O10)
export const messages = { ops, common, staff, customers, money, ss: supportSystem, pl: privacyLegal, ob: overviewBusiness, ent: entitlements, dlv: deliveries, sset: supportSettings, mob: mobile, ann: announcements, promo: promotions, cl: changelog };
