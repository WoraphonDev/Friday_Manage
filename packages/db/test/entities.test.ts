import { readFileSync } from 'node:fs';
import { is, Table } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.ts';

const owner = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL ?? 'postgres://friday_owner:friday_owner_dev@localhost:54329/friday' });
const spec = readFileSync(new URL('../../../docs/spec/01-entities.md', import.meta.url), 'utf8');
const entities = [...spec.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]);
const plural = (name: string) => /[^aeiou]y$/.test(name) ? `${name.slice(0, -1)}ies` : /(?:s|x|ch|sh)$/.test(name) ? `${name}es` : `${name}s`;
const opsTables = ['staff_users', 'support_sessions', 'feature_flags', 'feature_flag_overrides', 'announcements', 'entitlement_versions', 'entitlement_overrides'];

beforeAll(() => owner.connect());
afterAll(() => owner.end());

describe('Entity ทุกหมวดตามสเปก', () => {
  it('ทุก entity มีตารางจริงและเปิด RLS', async () => {
    expect(entities.length).toBeGreaterThan(100);
    const { rows } = await owner.query(`SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public'`);
    const tables = new Map(rows.map((r) => [r.tablename, r.rowsecurity]));
    for (const entity of entities) expect(tables.get(plural(entity)), entity).toBe(true);
  });

  it('Drizzle export ครบทุกตารางที่ระบุในสเปก', () => {
    const names = Object.values(schema).filter((value) => is(value, Table)).map((table) => getTableConfig(table).name);
    expect(names.sort()).toEqual(entities.map(plural).sort());
  });

  it('FK ใหม่ระหว่างตาราง tenant ต้องรวม workspace_id ทั้งสองฝั่ง', async () => {
    const { rows } = await owner.query(`
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class src ON src.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = src.relnamespace
      JOIN pg_attribute sw ON sw.attrelid = c.conrelid AND sw.attname = 'workspace_id'
      JOIN pg_attribute tw ON tw.attrelid = c.confrelid AND tw.attname = 'workspace_id'
      WHERE c.contype = 'f' AND ns.nspname = 'public'
        AND src.relname = ANY($1::text[])
        AND NOT (sw.attnum = ANY(c.conkey) AND tw.attnum = ANY(c.confkey))`,
    [entities.filter((e) => /^(line_|calendar_feed|sso_|verified_|project_template|git_|project_repository|pull_request|issue_git|notification_delivery|user_notification|email_sender|webhook|project_notification|report_schedule|automation|saved_|api_token|data_subject|workspace_export|plan$|subscription|billing_profile|invoice|payment|tax_document|wht_|legal_|staff_|support_|feature_|announcement|entitlement_)/.test(e)).map(plural)]);
    expect(rows).toEqual([]);
  });

  it('ตารางหลังบ้านไม่มีสิทธิ์ใดสำหรับ friday_app', async () => {
    for (const table of opsTables) {
      const { rows } = await owner.query(`SELECT has_table_privilege('friday_app', $1, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed`, [`public.${table}`]);
      expect(rows[0].allowed, table).toBe(false);
    }
  });

  it('plans / legal_documents ให้ friday_app อ่านอย่างเดียว', async () => {
    for (const table of ['plans', 'legal_documents']) {
      const { rows } = await owner.query(`SELECT has_table_privilege('friday_app', $1, 'SELECT') AS read,
        has_table_privilege('friday_app', $1, 'INSERT,UPDATE,DELETE,TRUNCATE') AS write`, [`public.${table}`]);
      expect(rows[0], table).toEqual({ read: true, write: false });
    }
  });

  it('GIN trigram index ครบและใช้ได้จริง', async () => {
    const { rows } = await owner.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE '%_trgm_idx'`);
    expect(rows.map((r) => r.indexname).sort()).toEqual(['comments_body_trgm_idx', 'files_name_trgm_idx', 'issues_description_trgm_idx', 'issues_title_trgm_idx']);
    for (const row of rows) expect(row.indexdef).toContain('USING gin');
    expect((await owner.query(`SELECT similarity('Friday', 'Friday') AS score`)).rows[0].score).toBe(1);
  });
});
