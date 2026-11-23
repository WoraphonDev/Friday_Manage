import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * schema ของผลลัพธ์ (A40) อ่านจากชนิดที่ handler ของ controller คืนค่า (TypeScript compiler API)
 * ไม่ต้องเขียน schema ของ response ซ้ำทีละ endpoint และตรงกับโค้ดเสมอเพราะมาจากชนิดเดียวกับที่ tsc ตรวจ
 * ใช้ตอนสร้าง openapi.json (test / `pnpm --filter @friday/api openapi`) เท่านั้น · production ไม่ import ไฟล์นี้ (ไม่มี typescript ใน image)
 */

type Json = Record<string, unknown>;

export interface ResponseTypes {
  /** `ชื่อ controller.ชื่อ handler` → schema ของผลลัพธ์ · ไม่มี = เขียน response เอง (`@Res()`) หรืออ่านชนิดไม่ได้ */
  responses: Record<string, Json>;
  /** ชนิดที่ตั้งชื่อไว้ในโค้ด (interface / type) ใช้ซ้ำผ่าน `$ref` */
  schemas: Record<string, Json>;
}

const HTTP = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'All', 'Head', 'Options']);
const MAX_DEPTH = 12;

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(here, '..', '..');
const repoRoot = join(apiRoot, '..', '..');

function decoratorNames(node: ts.Node) {
  return (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []).map((d) => {
    const e = d.expression;
    return { name: ts.isCallExpression(e) ? e.expression.getText() : e.getText(), call: ts.isCallExpression(e) ? e : undefined };
  });
}

/** `@Res()` ที่ไม่มี passthrough = handler เขียน response เอง (redirect / ไฟล์) ค่าที่ return ไม่ใช่ผลลัพธ์ */
function writesOwnResponse(m: ts.MethodDeclaration) {
  return m.parameters.some((p) =>
    decoratorNames(p).some((d) => (d.name === 'Res' || d.name === 'Response') && !d.call?.arguments.some((a) => /passthrough\s*:\s*true/.test(a.getText()))),
  );
}

export function responseTypes(): ResponseTypes {
  const configPath = join(apiRoot, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, apiRoot);
  const srcDir = join(apiRoot, 'src') + sep;
  const program = ts.createProgram({ rootNames: parsed.fileNames.filter((f) => f.startsWith(srcDir)), options: parsed.options });
  const checker = program.getTypeChecker();
  const conv = new Converter(checker);
  const responses: Record<string, Json> = {};

  for (const file of program.getSourceFiles()) {
    if (!file.fileName.startsWith(srcDir) || file.isDeclarationFile) continue;
    ts.forEachChild(file, function visit(node) {
      if (ts.isClassDeclaration(node) && node.name && decoratorNames(node).some((d) => d.name === 'Controller')) {
        for (const m of node.members) {
          if (!ts.isMethodDeclaration(m) || !ts.isIdentifier(m.name)) continue;
          if (!decoratorNames(m).some((d) => HTTP.has(d.name)) || writesOwnResponse(m)) continue;
          const sig = checker.getSignatureFromDeclaration(m);
          if (!sig) continue;
          const ret = checker.getReturnTypeOfSignature(sig);
          const schema = conv.schema(checker.getAwaitedType(ret) ?? ret);
          if (Object.keys(schema).length) responses[`${node.name.text}.${m.name.text}`] = schema;
        }
      }
      ts.forEachChild(node, visit);
    });
  }
  return { responses: sortKeys(responses), schemas: sortKeys(conv.named) };
}

const sortKeys = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

class Converter {
  readonly named: Record<string, Json> = {};
  /** ชนิดที่ตั้งชื่อ → ชื่อใน components (ชื่อซ้ำจากคนละไฟล์ได้ชื่อพร้อมโฟลเดอร์) */
  private readonly names = new Map<ts.Type, string>();
  private readonly stack = new Set<ts.Type>();

  constructor(private readonly checker: ts.TypeChecker) {}

  schema(t: ts.Type, depth = 0): Json {
    const f = t.flags;
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return {};
    if (f & ts.TypeFlags.Null) return { type: 'null' };
    if (f & ts.TypeFlags.StringLiteral) return { type: 'string', const: (t as ts.StringLiteralType).value };
    if (f & ts.TypeFlags.NumberLiteral) return { type: 'number', const: (t as ts.NumberLiteralType).value };
    if (f & ts.TypeFlags.BooleanLiteral) return { type: 'boolean', const: this.checker.typeToString(t) === 'true' };
    if (f & ts.TypeFlags.String || f & ts.TypeFlags.TemplateLiteral) return { type: 'string' };
    if (f & ts.TypeFlags.Number) return { type: 'number' };
    if (f & ts.TypeFlags.Boolean) return { type: 'boolean' };
    // JSON.stringify ไม่รับ bigint · โค้ดที่ตอบ bigint ต้องแปลงเป็น string ก่อน
    if (f & ts.TypeFlags.BigInt || f & ts.TypeFlags.BigIntLiteral) return { type: 'string' };
    if (f & ts.TypeFlags.EnumLiteral && t.isUnion()) return this.union(t.types, depth);
    if (t.isUnion()) return this.union(t.types, depth);
    if (depth > MAX_DEPTH || this.stack.has(t)) return {};

    const sym = t.getSymbol();
    const symName = sym?.getName();
    if (symName === 'Date') return { type: 'string', format: 'date-time' };
    // ดาวน์โหลดไฟล์ (StreamableFile ของ Nest) · openapi.ts แสดงเป็น application/octet-stream
    if (symName === 'Buffer' || symName === 'Uint8Array' || symName === 'StreamableFile') return { type: 'string', format: 'binary' };
    if (symName === 'Map' || symName === 'Set' || symName === 'Promise') return {};
    if (this.checker.isTupleType(t)) {
      const args = this.checker.getTypeArguments(t as ts.TypeReference);
      return { type: 'array', prefixItems: args.map((a) => this.schema(a, depth + 1)), minItems: args.length, maxItems: args.length };
    }
    if (this.checker.isArrayType(t)) return { type: 'array', items: this.schema(this.checker.getTypeArguments(t as ts.TypeReference)[0]!, depth + 1) };
    if (!(f & ts.TypeFlags.Object) && !t.isIntersection()) return {};
    // ฟังก์ชันไม่ถูกส่งเป็น JSON
    if (t.getCallSignatures().length && !t.getProperties().length) return {};

    const name = this.nameOf(t);
    if (name && this.named[name]) return { $ref: `#/components/schemas/${name}` };
    this.stack.add(t);
    try {
      const out = this.object(t, depth);
      if (!name) return out;
      this.named[name] = out;
      return { $ref: `#/components/schemas/${name}` };
    } finally {
      this.stack.delete(t);
    }
  }

  private object(t: ts.Type, depth: number): Json {
    const properties: Json = {};
    const required: string[] = [];
    for (const p of this.checker.getPropertiesOfType(t)) {
      const decl = p.valueDeclaration ?? p.declarations?.[0];
      if (decl && (ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl))) continue;
      const pt = this.checker.getTypeOfSymbol(p);
      if (pt.getCallSignatures().length && !pt.getProperties().filter((x) => x.getName() !== 'prototype').length) continue;
      properties[p.getName()] = this.schema(pt, depth + 1);
      const optional = p.flags & ts.SymbolFlags.Optional || (pt.isUnion() && pt.types.some((x) => x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
      if (!optional) required.push(p.getName());
    }
    const out: Json = { type: 'object', properties };
    if (required.length) out.required = required;
    const index = this.checker.getIndexInfosOfType(t).find((i) => i.keyType.flags & (ts.TypeFlags.String | ts.TypeFlags.Number));
    if (index) out.additionalProperties = this.schema(index.type, depth + 1);
    return out;
  }

  private union(types: readonly ts.Type[], depth: number): Json {
    const rest = types.filter((x) => !(x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
    const nullable = rest.some((x) => x.flags & ts.TypeFlags.Null);
    let items = rest.filter((x) => !(x.flags & ts.TypeFlags.Null));
    // true | false = boolean
    const bools = items.filter((x) => x.flags & ts.TypeFlags.BooleanLiteral);
    if (bools.length === 2) items = [...items.filter((x) => !(x.flags & ts.TypeFlags.BooleanLiteral)), this.checker.getBooleanType()];
    let base: Json;
    if (!items.length) return nullable ? { type: 'null' } : {};
    if (items.every((x) => x.flags & ts.TypeFlags.StringLiteral)) base = { type: 'string', enum: items.map((x) => (x as ts.StringLiteralType).value) };
    else if (items.every((x) => x.flags & ts.TypeFlags.NumberLiteral)) base = { type: 'number', enum: items.map((x) => (x as ts.NumberLiteralType).value) };
    else if (items.length === 1) base = this.schema(items[0]!, depth);
    else {
      const parts = items.map((x) => this.schema(x, depth));
      // ส่วนใดอ่านไม่ได้ ({}) = ทั้งหมดเป็นอะไรก็ได้
      if (parts.some((p) => !Object.keys(p).length)) return {};
      base = { anyOf: parts };
    }
    if (!nullable) return base;
    if (typeof base.type === 'string' && !base.$ref) return { ...base, type: [base.type, 'null'], ...(base.enum ? { enum: [...(base.enum as unknown[]), null] } : {}) };
    return { anyOf: [...((base.anyOf as Json[] | undefined) ?? [base]), { type: 'null' }] };
  }

  /** ชื่อใน components: interface / type alias ที่ประกาศในโค้ดของเรา (src ของ api หรือ packages) และไม่มี type argument */
  private nameOf(t: ts.Type): string | undefined {
    const cached = this.names.get(t);
    if (cached) return cached;
    const sym = t.aliasSymbol ?? t.getSymbol();
    if (!sym || t.aliasTypeArguments?.length || (t as ts.TypeReference).typeArguments?.length) return undefined;
    const n = sym.getName();
    if (!/^[A-Z][A-Za-z0-9]*$/.test(n)) return undefined;
    const decl = sym.declarations?.[0];
    if (!decl || !(ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl) || ts.isClassDeclaration(decl))) return undefined;
    const file = decl.getSourceFile().fileName;
    if (file.includes(`${sep}node_modules${sep}`) || !file.startsWith(repoRoot)) return undefined;
    let name = n;
    const taken = [...this.names.entries()].find(([other, v]) => v === name && other !== t);
    if (taken) name = `${relative(repoRoot, dirname(file)).split(sep).filter((x) => !['apps', 'src', 'packages'].includes(x)).map((x) => x.replace(/(^|[-_])(\w)/g, (_m, _s, c: string) => c.toUpperCase())).join('')}${n}`;
    this.names.set(t, name);
    return name;
  }
}
