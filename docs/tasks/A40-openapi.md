# A40 · OpenAPI ของทุก endpoint

| | |
|---|---|
| Wave | 3 · ปิดท้าย |
| รอ merge | ทุกงาน A |
| Lane (แก้ได้เฉพาะ) | ทุก controller ใน `apps/api/src/**` (ทำตอนไม่มีงาน API อื่นเปิดอยู่) |
| หน้าจอ | — |
| สเปก | 03-api › 3 (ส่วนที่บอกว่ารายละเอียดได้จาก OpenAPI) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- สร้าง OpenAPI 3.1 จาก zod schema ที่ใช้ `parse()` อยู่แล้ว · `GET /api/v1/openapi.json` (เฉพาะ dev) และไฟล์ `apps/api/openapi.json`
- test ที่ตรวจว่าทุก route มีเอกสาร

## กติกาที่ต้องตรง

- ไม่เปลี่ยนพฤติกรรมของ endpoint

## เสร็จเมื่อ

- [x] test ผ่าน · ไฟล์ OpenAPI เปิดใน Swagger UI ได้
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

### สิ่งที่เพิ่ม (`apps/api/src/openapi/`)

| ที่ | หมายเหตุ |
|---|---|
| `apps/api/openapi.json` | OpenAPI **3.1.0** ของทุก endpoint (277 path · 369 operation) · commit ไว้ในรีโป |
| `GET /api/v1/openapi.json` | ส่งไฟล์ข้างบน · ไม่ต้องล็อกอิน · **เฉพาะ dev/test** (`NODE_ENV=production` ตอบ 404) |
| `GET /api/v1/docs` | หน้า Swagger UI (โหลดจาก unpkg `swagger-ui-dist@5.18.2`) ชี้ไปที่ openapi.json · เฉพาะ dev/test |
| `pnpm --filter @friday/api openapi` | สร้างไฟล์ใหม่ (`UPDATE_OPENAPI=1 vitest run test/openapi.e2e.test.ts`) |

### วิธีสร้าง (ไม่ต้องแก้ controller ทีละไฟล์ และไม่เปลี่ยนพฤติกรรมของ endpoint)

1. **route** มาจาก `DiscoveryService` ของ Nest (path ของ controller + method, prefix `api/v1`, ทุกชื่อ path ที่ประกาศเป็นอาร์เรย์ เช่น `x/y` กับ `x\:y` เป็นคนละรายการ) · `:name` → `{name}`
2. **request body / query** มาจาก zod schema ที่ handler ส่งเข้า `parse()` จริง: ตัวสร้างเรียก handler กับ **service ปลอม (Proxy)** ในโหมดสำรวจ — `common/validate.ts` เพิ่มทางลัดเล็ก ๆ ที่ `parse` จดชนิด `body` / `query` ของ schema แล้วคืน `{}` (เฉพาะเมื่อกำลังสำรวจ; นอกโหมดนี้ทำงานเหมือนเดิมทุกประการ) แล้วแปลงด้วย `z.toJSONSchema` (JSON Schema 2020-12)
3. header ที่ handler อ่าน (`If-Match`, `Idempotency-Key`, …) มาจาก `@Headers()` · อัปโหลดไฟล์ (`@UploadedFile`) → `multipart/form-data` · `@Public()` → `security: []` · คำขอเขียนที่ใช้ Session cookie ได้ `x-csrf-token` (component `CsrfToken`) · ตอบสำเร็จตาม `@HttpCode` (POST ค่าเริ่มต้น 201) · error อ้าง component `Error` (`{ error: { code, message, details } }`)
4. คำอธิบาย (summary) ใช้คอมเมนต์ JSDoc บรรทัดแรกเหนือ method ถ้ามี ไม่มีใช้ `METHOD path` (ไม่ซ้ำและบอกหน้าที่ได้)

### ข้อจำกัดที่รู้

- **schema ของผลลัพธ์ยังไม่ระบุ** (ตอบ JSON ทั่วไป) — โค้ดปัจจุบันไม่มี schema ของ response ให้ดึง · ถ้าจะให้ละเอียดต้องเพิ่ม zod schema ของ response ที่ service (งานต่อเนื่อง)
- route ที่ตรวจข้อมูลในชั้น **service** แทนที่จะเรียก `parse()` ใน controller จะแสดง request body เป็น object ทั่วไป · route ที่ `parse(schema, { ...body, x })` (ไม่ส่ง body ตรง ๆ) ก็เช่นกัน
- คำอธิบายภาษาไทยมีเฉพาะ handler ที่มี JSDoc (ตอนนี้น้อย) — เพิ่มคอมเมนต์เหนือ method ใน controller ได้เรื่อย ๆ แล้วรัน `pnpm --filter @friday/api openapi`

### test (`apps/api/test/openapi.e2e.test.ts` 7 ข้อ)

- **ทุก route ที่ Express ลงทะเบียนจริงมีเอกสาร** (เทียบ `router.stack` กับ spec) และไม่มีเอกสารของ route ที่ไม่มีจริง — เพิ่ม endpoint ใหม่โดยไม่ได้อัปเดต `openapi.json` แล้ว CI ล้ม (ข้อ drift ด้านล่างด้วย)
- โครงเอกสาร: 3.1.0, operationId ไม่ซ้ำ, path param ครบทุกตัว, ทุก operation มี summary/responses
- body/query มาจาก zod จริง (สร้างงาน, checkout + `Idempotency-Key`, audit-log query, PATCH issue + `If-Match`)
- ชนิดพิเศษ: multipart, `:action`, hook สาธารณะ, CSRF, security scheme
- **ไฟล์ `openapi.json` ตรงกับโค้ดปัจจุบัน** (รัน `pnpm --filter @friday/api openapi` เพื่ออัปเดต)
- `GET openapi.json` / `docs` เปิดใน dev และ 404 ใน production

### คำขอนอก lane

- **D99**: ให้ README ชี้ไป `apps/api/openapi.json` และ `/api/v1/docs`; ตั้งธรรมเนียมใน `AGENTS.md` ว่า "เพิ่ม/แก้ endpoint แล้วรัน `pnpm --filter @friday/api openapi`"
- **W (ทุกหน้า)**: สร้าง type ของ client จาก `openapi.json` ได้ (เช่น `openapi-typescript`) — ตอนนี้ได้ type ของ request ครบ ส่วน response ยังเป็น `unknown`
- ไม่ได้ทำ: เอกสาร API ของหลังบ้าน `apps/ops-api` (แอปแยก; ใช้สเปก 03-api › 3.12 และบันทึกผล A32)

`pnpm typecheck` ผ่านทั้ง monorepo · `pnpm test` ผ่านทุกแพ็กเกจ (API 529, ops-api 17)
