import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { DocsController, OpenApiController } from './openapi.controller.js';

/** OpenAPI ของทุก endpoint · งาน A40 (docs/tasks/A40-openapi.md) */
@Module({ imports: [DiscoveryModule], controllers: [OpenApiController, DocsController] })
export class OpenApiModule {}
