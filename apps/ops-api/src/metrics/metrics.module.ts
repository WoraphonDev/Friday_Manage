import { Controller, Get, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service.js';

/** ตัวเลขธุรกิจ (O06 ขยายเป็นภาพรวม และธุรกิจและกำไร) */
@Controller('ops')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  getMetrics() {
    return this.metrics.get();
  }
}

@Module({ controllers: [MetricsController], providers: [MetricsService], exports: [MetricsService] })
export class MetricsModule {}
