import { Module } from '@nestjs/common';
import { DiagramsController } from './diagrams.controller.js';
import { DiagramsService } from './diagrams.service.js';

/** แท็บ Diagram (Flowchart / ER / สถาปัตยกรรม / ไวท์บอร์ด) · ผู้ใช้อนุมัติ storyboard 2026-11-19 */
@Module({
  controllers: [DiagramsController],
  providers: [DiagramsService],
  exports: [DiagramsService],
})
export class DiagramsModule {}
