import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { z } from 'zod';
import { IS_PUBLIC } from '../common/request.js';
import { schemaProbe, type SchemaProbe } from '../common/validate.js';

/** RouteParamtypes ของ Nest */
const T = { REQUEST: 0, RESPONSE: 1, BODY: 3, QUERY: 4, PARAM: 5, HEADERS: 6, FILE: 8, FILES: 9 } as const;
const METHODS: Record<number, string> = { [RequestMethod.GET]: 'get', [RequestMethod.POST]: 'post', [RequestMethod.PUT]: 'put', [RequestMethod.DELETE]: 'delete', [RequestMethod.PATCH]: 'patch', [RequestMethod.OPTIONS]: 'options', [RequestMethod.HEAD]: 'head' };
const PREFIX = 'api/v1';

type Json = Record<string, unknown>;

/** วัตถุปลอมที่รับทุกการเรียก / อ่านค่า — ใช้แทน service และ request/response ตอนสำรอง handler */
function stub(): never {
  const f = () => undefined;
  const p: object = new Proxy(f, { get: (_t, k) => (k === 'then' || k === Symbol.toPrimitive ? undefined : p), apply: () => p, construct: () => p, has: () => true });
  return p as never;
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined ? [''] : [String(v)]);
const join2 = (...parts: string[]) => '/' + parts.flatMap((p) => p.split('/')).filter(Boolean).join('/');

/** Express `:name` → OpenAPI `{name}` · `\:` (ตัวอักษร ':' ตามสเปก เช่น `/issues/{key}:restore`) → ':' */
export function toOpenApiPath(path: string) {
  return path.replace(/\\:/g, '\u0000').replace(/:([A-Za-z_]\w*)/g, '{$1}').replace(/\u0000/g, ':');
}
const pathParams = (path: string) => [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

function sourceFiles(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|js)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** คอมเมนต์ JSDoc บรรทัดแรกที่อยู่เหนือ method (ถ้ามี) ใช้เป็นคำอธิบายของ operation */
function docOf(source: string, classBody: number, handler: string): string | undefined {
  const m = new RegExp(`\\n  (?:async )?${handler}\\(`).exec(source.slice(classBody));
  if (!m) return undefined;
  const before = source.slice(0, classBody + m.index);
  const start = before.lastIndexOf('/**');
  if (start < 0) return undefined;
  const end = before.indexOf('*/', start);
  // ระหว่างคอมเมนต์กับ method ต้องมีแค่ decorator
  if (end < 0 || /[;{}]/.test(before.slice(end + 2).replace(/@\w+\((?:[^()]|\([^()]*\))*\)/g, ''))) return undefined;
  return before.slice(start + 3, end).split('\n').map((l) => l.replace(/^\s*\*?\s?/, '').trim()).filter(Boolean)[0];
}

function jsonSchema(schema: z.ZodType, io: 'input' | 'output' = 'input'): Json {
  try {
    const { $schema: _ignore, ...rest } = z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'any' }) as Json;
    return rest;
  } catch {
    return { type: 'object' };
  }
}

export interface RouteInfo {
  controller: string;
  handler: string;
  method: string;
  path: string;
  expressPath: string;
}

/** รายการ route ที่ Nest ลงทะเบียน (ที่มาเดียวกับที่ใช้เทียบกับ Express ใน test) */
export function listRoutes(app: INestApplication): RouteInfo[] {
  const discovery = app.get(DiscoveryService);
  const out: RouteInfo[] = [];
  for (const w of discovery.getControllers()) {
    const cls = w.metatype as (new (...a: never[]) => object) | null;
    if (!cls) continue;
    for (const handler of Object.getOwnPropertyNames(cls.prototype)) {
      const fn = (cls.prototype as Record<string, unknown>)[handler];
      if (typeof fn !== 'function' || handler === 'constructor') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, fn) as number | undefined;
      if (method === undefined) continue;
      for (const c of asList(Reflect.getMetadata(PATH_METADATA, cls))) {
        for (const p of asList(Reflect.getMetadata(PATH_METADATA, fn))) {
          const expressPath = join2(PREFIX, c, p);
          out.push({ controller: cls.name, handler, method: METHODS[method] ?? 'all', path: toOpenApiPath(expressPath), expressPath });
        }
      }
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** เรียก handler กับ service ปลอม เพื่อจด schema ที่ส่งเข้า `parse` (body / query) · ไม่แตะฐานข้อมูล */
async function probeSchemas(instance: object, cls: Function, handler: string) {
  const fn = (cls.prototype as Record<string, (...a: unknown[]) => unknown>)[handler];
  const meta = (Reflect.getMetadata(ROUTE_ARGS_METADATA, cls, handler) ?? {}) as Record<string, { index: number; data?: unknown }>;
  const probe: SchemaProbe = { found: [], body: {}, query: {} };
  const args: unknown[] = [];
  const headers: string[] = [];
  let upload = false;
  for (const [key, v] of Object.entries(meta)) {
    const type = Number(key.split(':')[0]);
    args[v.index] = type === T.BODY ? probe.body : type === T.QUERY ? probe.query : stub();
    if (type === T.HEADERS && typeof v.data === 'string') headers.push(v.data);
    if (type === T.FILE || type === T.FILES) upload = true;
  }
  for (let i = 0; i < args.length; i++) args[i] ??= stub();
  // controller จำลอง: คุณสมบัติที่ฉีดเข้ามา (service) ถูกแทนด้วยตัวปลอมทั้งหมด
  const shadow = Object.create(Object.getPrototypeOf(instance)) as Record<string, unknown>;
  for (const k of Object.keys(instance)) shadow[k] = stub();
  await schemaProbe.run(probe, async () => {
    try {
      await fn.apply(shadow, args);
    } catch {
      /* handler ปลอมอาจ throw หลัง parse แล้ว · ไม่เป็นไร */
    }
  });
  return { found: probe.found, headers, upload };
}

const ERROR_REF = { $ref: '#/components/responses/Error' };

export interface BuildOptions {
  title?: string;
  version?: string;
}

/** สร้าง OpenAPI 3.1 จาก route ที่ Nest ลงทะเบียน + zod schema ที่ handler ส่งเข้า `parse` */
export async function buildOpenApi(app: INestApplication, opts: BuildOptions = {}) {
  const discovery = app.get(DiscoveryService);
  const here = dirname(fileURLToPath(import.meta.url));
  const srcRoot = join(here, '..');
  const files = sourceFiles(srcRoot).map((f) => ({ f, text: readFileSync(f, 'utf8') }));
  const fileOf = (cls: string) => {
    const re = new RegExp(`export class ${cls}\\b`);
    const hit = files.find((x) => re.test(x.text));
    return hit ? { text: hit.text, at: hit.text.search(re) } : undefined;
  };

  const paths: Record<string, Record<string, Json>> = {};
  const seenOps = new Map<string, number>();
  const tags = new Set<string>();

  for (const w of discovery.getControllers()) {
    const cls = w.metatype as (new (...a: never[]) => object) | null;
    const instance = w.instance as object | undefined;
    if (!cls || !instance) continue;
    const tag = cls.name.replace(/Controller$/, '');
    const src = fileOf(cls.name);
    for (const handler of Object.getOwnPropertyNames(cls.prototype)) {
      const fn = (cls.prototype as Record<string, unknown>)[handler];
      if (typeof fn !== 'function' || handler === 'constructor') continue;
      const methodId = Reflect.getMetadata(METHOD_METADATA, fn) as number | undefined;
      if (methodId === undefined) continue;
      const method = METHODS[methodId] ?? 'get';
      const isPublic = !!(Reflect.getMetadata(IS_PUBLIC, fn) ?? Reflect.getMetadata(IS_PUBLIC, cls));
      const { found, headers, upload } = await probeSchemas(instance, cls, handler);
      const documented = src ? docOf(src.text, src.at, handler) : undefined;
      const httpCode = (Reflect.getMetadata(HTTP_CODE_METADATA, fn) as number | undefined) ?? (method === 'post' ? 201 : 200);
      const write = method !== 'get' && method !== 'head';

      for (const c of asList(Reflect.getMetadata(PATH_METADATA, cls))) {
        for (const p of asList(Reflect.getMetadata(PATH_METADATA, fn))) {
          const path = toOpenApiPath(join2(PREFIX, c, p));
          const base = `${tag}_${handler}`;
          const n = (seenOps.get(base) ?? 0) + 1;
          seenOps.set(base, n);

          const parameters: Json[] = pathParams(path).map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } }));
          for (const h of headers) parameters.push({ name: h, in: 'header', required: h.toLowerCase() === 'idempotency-key', schema: { type: 'string' } });
          if (write && !isPublic) parameters.push({ $ref: '#/components/parameters/CsrfToken' });

          const query = found.find((x) => x.kind === 'query') ?? (method === 'get' ? found.find((x) => x.kind === 'other') : undefined);
          if (query) {
            const js = jsonSchema(query.schema);
            const required = new Set((js.required as string[] | undefined) ?? []);
            for (const [name, schema] of Object.entries((js.properties as Json | undefined) ?? {})) parameters.push({ name, in: 'query', required: required.has(name), schema });
          }
          const body = found.find((x) => x.kind === 'body') ?? (write ? found.find((x) => x.kind === 'other') : undefined);
          const op: Json = {
            operationId: n === 1 ? base : `${base}_${n}`,
            // ไม่มีคอมเมนต์ในโค้ด = ใช้ "METHOD path" ซึ่งบอกหน้าที่ได้ดีพอและไม่ซ้ำ
            summary: documented ?? `${method.toUpperCase()} ${path.replace(`/${PREFIX}/`, '')}`,
            tags: [tag],
            parameters,
            responses: {
              [String(httpCode)]: { description: 'สำเร็จ', content: { 'application/json': { schema: {} } } },
              ...(isPublic ? {} : { '401': ERROR_REF, '403': ERROR_REF }),
              ...(body || query ? { '400': ERROR_REF } : {}),
              ...(pathParams(path).length ? { '404': ERROR_REF } : {}),
            },
          };
          if (upload) op.requestBody = { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] } } } };
          else if (body) op.requestBody = { required: true, content: { 'application/json': { schema: jsonSchema(body.schema) } } };
          else if (write) op.requestBody = { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } };
          if (isPublic) op.security = [];
          (paths[path] ??= {})[method] = op;
          tags.add(tag);
        }
      }
    }
  }

  const sorted = Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b)));
  return {
    openapi: '3.1.0',
    info: {
      title: opts.title ?? 'Friday Work Management API',
      version: opts.version ?? '1.0.0',
      description: 'API ของ Friday Work Management (สร้างอัตโนมัติจาก route ของ NestJS และ zod schema ที่ handler ใช้ตรวจข้อมูลขาเข้า) · รูปแบบ error และข้อตกลงอื่น ๆ ดู docs/spec/03-api.md\n\nข้อควรรู้: schema ของ **ผลลัพธ์** ยังไม่ระบุ (ตอบเป็น JSON) และ route ที่ตรวจข้อมูลในชั้น service แทน controller จะแสดง request body แบบ object ทั่วไป',
    },
    servers: [{ url: '/' }],
    tags: [...tags].sort().map((name) => ({ name })),
    security: [{ cookieAuth: [] }, { bearerAuth: [] }],
    paths: sorted,
    components: {
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'fm_session', description: 'Session cookie ของผู้ใช้ · คำขอที่เขียนต้องส่ง x-csrf-token ด้วย' },
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'API token (ขึ้นต้น fm_) · ไม่ต้องใช้ CSRF' },
      },
      parameters: { CsrfToken: { name: 'x-csrf-token', in: 'header', required: true, description: 'ได้จาก GET /api/v1/auth/csrf (เฉพาะ Session cookie)', schema: { type: 'string' } } },
      responses: {
        Error: {
          description: 'ข้อผิดพลาด · รหัสใน `error.code` ใช้แยกกรณี (เช่น invalid_input, forbidden, not_found, conflict, plan_limit_reached)',
          content: { 'application/json': { schema: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' }, details: {}, requestId: { type: 'string' } } } } } } },
        },
      },
    },
  };
}

export type OpenApiDoc = Awaited<ReturnType<typeof buildOpenApi>>;
