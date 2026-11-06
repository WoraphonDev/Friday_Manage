import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller, Get, Header } from '@nestjs/common';
import { AppError } from '../common/errors.js';
import { Public } from '../common/request.js';

/** ตำแหน่งไฟล์ที่ commit ไว้: apps/api/openapi.json (src/openapi → ../../ และ dist/openapi → ../../ เหมือนกัน) */
export const OPENAPI_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'openapi.json');

/** `GET /api/v1/openapi.json` เฉพาะ dev / test · production ตอบ 404 เพื่อไม่เปิดแผนที่ API ให้ภายนอก */
@Controller('openapi.json')
export class OpenApiController {
  @Public()
  @Get()
  get() {
    if (process.env.NODE_ENV === 'production') throw new AppError(404, 'not_found', 'ไม่พบหน้านี้');
    try {
      return JSON.parse(readFileSync(OPENAPI_FILE, 'utf8')) as object;
    } catch {
      throw new AppError(404, 'openapi_not_generated', 'ยังไม่ได้สร้าง openapi.json · รัน pnpm --filter @friday/api openapi');
    }
  }
}

const SWAGGER_UI = '5.18.2';

/** `GET /api/v1/docs` หน้า Swagger UI สำหรับอ่าน openapi.json (dev / test เท่านั้น) */
@Controller('docs')
export class DocsController {
  @Public()
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  page() {
    if (process.env.NODE_ENV === 'production') throw new AppError(404, 'not_found', 'ไม่พบหน้านี้');
    return `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Friday Manage API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@${SWAGGER_UI}/swagger-ui.css" />
</head>
<body>
  <div id="ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@${SWAGGER_UI}/swagger-ui-bundle.js"></script>
  <script>window.ui = SwaggerUIBundle({ url: '/api/v1/openapi.json', dom_id: '#ui', deepLinking: true });</script>
</body>
</html>`;
  }
}
