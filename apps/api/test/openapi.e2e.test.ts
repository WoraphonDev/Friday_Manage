// A40 · OpenAPI ของทุก endpoint
import { readFileSync, writeFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPENAPI_FILE } from '../src/openapi/openapi.controller.js';
import { buildOpenApi, listRoutes, type OpenApiDoc } from '../src/openapi/openapi.js';
import { client, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let doc: OpenApiDoc;
const ops = () => Object.entries(doc.paths).flatMap(([path, item]) => Object.entries(item).map(([method, op]) => ({ path, method, op: op as Record<string, unknown> & { operationId: string; parameters: { name: string; in: string; required?: boolean; $ref?: string }[]; responses: Record<string, unknown>; requestBody?: { content: Record<string, { schema: { properties?: Record<string, unknown>; required?: string[] } }> }; security?: unknown[]; summary: string } })));
const find = (method: string, path: string) => ops().find((o) => o.method === method && o.path === path)!;

/** route ที่ Express ลงทะเบียนจริง (ความจริงของระบบ ไม่ใช่ metadata ของ Nest) */
function expressRoutes(app: INestApplication) {
  const router = (app.getHttpAdapter().getInstance() as { router?: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } }).router;
  const out: string[] = [];
  for (const layer of router?.stack ?? []) {
    // `.all()` ที่ Nest ใส่ไว้ที่ prefix ไม่ใช่ endpoint ของเรา
    if (!layer.route || Object.keys(layer.route.methods).length > 10) continue;
    for (const m of Object.keys(layer.route.methods)) out.push(`${m} ${layer.route.path}`);
  }
  return out;
}

beforeAll(async () => {
  t = await startApp();
  doc = await buildOpenApi(t.app);
});
afterAll(() => t.close());

describe('OpenAPI 3.1', () => {
  it('ทุก route ที่ Express ลงทะเบียนมีเอกสาร และไม่มีเอกสารของ route ที่ไม่มีจริง', () => {
    const real = expressRoutes(t.app);
    expect(real.length).toBeGreaterThan(300);
    const docs = new Set(listRoutes(t.app).map((r) => `${r.method} ${r.expressPath}`));
    const missing = real.filter((r) => !docs.has(r));
    expect(missing, 'route ที่ไม่มีใน OpenAPI').toEqual([]);
    const ghost = [...docs].filter((d) => !real.includes(d));
    expect(ghost, 'เอกสารของ route ที่ไม่มีจริง').toEqual([]);
    // และทุก route นั้นอยู่ใน paths ของเอกสาร
    const inDoc = new Set(ops().map((o) => `${o.method} ${o.path}`));
    for (const r of listRoutes(t.app)) expect(inDoc.has(`${r.method} ${r.path}`), `${r.method} ${r.path}`).toBe(true);
  });

  it('โครงเอกสารถูกต้อง: เวอร์ชัน, operationId ไม่ซ้ำ, path param ครบ, ทุก operation มี summary และ responses', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('Friday Work Management API');
    const ids = ops().map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { path, method, op } of ops()) {
      const declared = op.parameters.filter((p) => p.in === 'path').map((p) => p.name).sort();
      const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(declared, `${method} ${path}`).toEqual(inPath);
      expect(op.summary, `${method} ${path}`).toBeTruthy();
      expect(Object.keys(op.responses).length, `${method} ${path}`).toBeGreaterThan(0);
      expect(path.startsWith('/api/v1/')).toBe(true);
    }
    for (const r of Object.values(doc.components.responses)) expect(r).toHaveProperty('description');
  });

  it('request body / query มาจาก zod schema ที่ handler ใช้ตรวจจริง', () => {
    const create = find('post', '/api/v1/w/{ws}/projects/{key}/issues');
    const schema = create.op.requestBody!.content['application/json'].schema;
    expect(Object.keys(schema.properties!)).toEqual(expect.arrayContaining(['title', 'priority', 'assigneeIds', 'moduleId']));
    expect(schema.required).toContain('title');
    expect(create.op.responses).toHaveProperty('201');

    const checkout = find('post', '/api/v1/w/{ws}/billing/checkout');
    expect(checkout.op.parameters.find((p) => p.name === 'idempotency-key')).toMatchObject({ in: 'header', required: true });
    expect(Object.keys(checkout.op.requestBody!.content['application/json'].schema.properties!)).toEqual(expect.arrayContaining(['plan', 'cycle', 'method', 'wht']));

    const audit = find('get', '/api/v1/w/{ws}/audit-log');
    expect(audit.op.parameters.filter((p) => p.in === 'query').map((p) => p.name)).toEqual(expect.arrayContaining(['category', 'user', 'from', 'to', 'limit', 'before']));

    const patch = find('patch', '/api/v1/w/{ws}/issues/{issueKey}');
    expect(patch.op.parameters.some((p) => p.name === 'if-match')).toBe(true);
    expect(Object.keys(patch.op.requestBody!.content['application/json'].schema.properties!)).toContain('statusId');
  });

  it('ชนิดพิเศษ: อัปโหลดไฟล์เป็น multipart · ดาวน์โหลด/สั่งงานแบบ colon · hook สาธารณะไม่ต้องล็อกอิน · เขียนต้องมี CSRF', () => {
    expect(find('post', '/api/v1/w/{ws}/import-jobs').op.requestBody!.content).toHaveProperty('multipart/form-data');
    expect(find('post', '/api/v1/w/{ws}/billing/invoices/{id}/slip').op.requestBody!.content).toHaveProperty('multipart/form-data');
    expect(find('get', '/api/v1/w/{ws}/projects/{key}/export.xlsx')).toBeTruthy();
    expect(find('post', '/api/v1/w/{ws}/billing/subscription:cancel')).toBeTruthy();
    expect(find('post', '/api/v1/hooks/stripe').op.security).toEqual([]);
    expect(find('post', '/api/v1/hooks/stripe').op.parameters.some((p) => p.$ref)).toBe(false);
    expect(find('post', '/api/v1/auth/login').op.security).toEqual([]);
    expect(find('post', '/api/v1/w/{ws}/teams').op.parameters.some((p) => p.$ref === '#/components/parameters/CsrfToken')).toBe(true);
    expect(find('get', '/api/v1/w/{ws}/teams').op.responses).toHaveProperty('403');
    expect(Object.keys(doc.components.securitySchemes)).toEqual(['cookieAuth', 'bearerAuth']);
  });

  it('คำอธิบาย operation มาจากคอมเมนต์ในโค้ด', () => {
    expect(find('get', '/api/v1/w/{ws}/projects/{key}/export.xlsx').op.summary).toContain('ดาวน์โหลดแผนงาน');
    // ที่ไม่มีคอมเมนต์ใช้ "METHOD path" เป็นคำอธิบาย
    expect(find('get', '/api/v1/w/{ws}/issues/{issueKey}/activity').op.summary).toBe('GET w/{ws}/issues/{issueKey}/activity');
  });

  it('ไฟล์ apps/api/openapi.json ตรงกับโค้ดปัจจุบัน (รัน `pnpm --filter @friday/api openapi` เพื่ออัปเดต)', () => {
    const fresh = `${JSON.stringify(doc, null, 2)}\n`;
    if (process.env.UPDATE_OPENAPI) {
      writeFileSync(OPENAPI_FILE, fresh);
      return;
    }
    expect(readFileSync(OPENAPI_FILE, 'utf8')).toBe(fresh);
  });

  it('GET /api/v1/openapi.json เปิดเฉพาะ dev / test (production ตอบ 404) และไม่ต้องล็อกอิน', async () => {
    const anon = await client(t.app);
    const r = await anon.get('/openapi.json');
    expect(r.status).toBe(200);
    expect(r.body.openapi).toBe('3.1.0');
    expect(Object.keys(r.body.paths).length).toBe(Object.keys(doc.paths).length);
    const docs = await anon.get('/docs');
    expect(docs.status).toBe(200);
    expect(docs.headers['content-type']).toContain('text/html');
    expect(docs.text).toContain('/api/v1/openapi.json');
    expect(docs.text).toContain('SwaggerUIBundle');
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect((await anon.get('/openapi.json')).status).toBe(404);
      expect((await anon.get('/docs')).status).toBe(404);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
