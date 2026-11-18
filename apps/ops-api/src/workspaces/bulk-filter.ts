import { z } from 'zod';

/** ตัวกรองชุดเดียวกับ GET ops/workspaces (ไม่รวมการเรียง / แบ่งหน้า) · ใช้ทั้งงานหลายราย (H4) และป้ายทดสอบ */
export const PLAN_CODES = ['free', 'team_s', 'team_m', 'team_l', 'enterprise'] as const;
export const FEATURES = ['line', 'webhook', 'github', 'api_token', 'automation', 'import', 'no_project'] as const;
export const BulkFilter = z
  .object({
    plan: z.enum(PLAN_CODES).optional(),
    status: z.enum(['trial', 'active', 'suspended', 'pending_delete', 'trialing', 'canceled', 'past_due']).optional(),
    q: z.string().trim().max(100).optional(),
    feature: z.enum(FEATURES).optional(),
    buyer: z.string().trim().max(80).optional(),
    test: z.enum(['hide', 'only', 'all']).default('hide'),
    suggest: z.enum(['any', 'staff_domain', 'name_prefix']).optional(),
  })
  .strict();
