import { pgEnum } from 'drizzle-orm/pg-core';

export const ssoType = pgEnum('sso_type', ['entra', 'google_workspace', 'saml', 'oidc']);
export const gitProvider = pgEnum('git_provider', ['github', 'gitlab']);
export const pullRequestState = pgEnum('pull_request_state', ['draft', 'open', 'merged', 'closed']);
export const gitLinkSource = pgEnum('git_link_source', ['branch', 'message', 'title', 'manual']);
// in_app ใช้เฉพาะ user_notification_prefs (คอลัมน์ In-app ของ Profile · A23) · ส่งออกนอกแอปไม่มีช่องนี้
export const notificationChannel = pgEnum('notification_channel', ['email', 'line', 'line_group', 'webhook', 'in_app']);
export const deliveryStatus = pgEnum('delivery_status', ['queued', 'sent', 'failed', 'skipped_quiet_hours']);
export const dueReminder = pgEnum('due_reminder', ['1d_and_today', '3d', 'today_only']);
export const digestFrequency = pgEnum('digest_frequency', ['workdays', 'daily', 'off']);
export const webhookFormat = pgEnum('webhook_format', ['discord', 'slack', 'teams', 'telegram', 'json']);
export const quietMode = pgEnum('quiet_mode', ['after_hours', 'always_send']);
export const automationTrigger = pgEnum('automation_trigger', ['issue_created', 'status_changed', 'subtasks_done', 'overdue', 'test_attached', 'sprint_started', 'sprint_completed', 'schedule']);
export const automationResult = pgEnum('automation_result', ['success', 'skipped', 'failed', 'retried']);
export const dataRequestType = pgEnum('data_request_type', ['erase', 'export']);
export const billingCycle = pgEnum('billing_cycle', ['monthly', 'yearly']);
export const subscriptionStatus = pgEnum('subscription_status', ['trialing', 'active', 'past_due', 'canceled']);
export const paymentMethod = pgEnum('payment_method', ['card', 'promptpay', 'transfer']);
export const branchType = pgEnum('branch_type', ['head', 'branch']);
export const invoiceStatus = pgEnum('invoice_status', ['open', 'pending_review', 'paid', 'void']);
export const paymentStatus = pgEnum('payment_status', ['pending_review', 'confirmed', 'rejected']);
export const supportMode = pgEnum('support_mode', ['read', 'write']);
export const announcementAudience = pgEnum('announcement_audience', ['all', 'owners_admins']);
