import { Module } from '@nestjs/common';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';
import { StorageController } from './storage.controller.js';
import { LocalStorage, S3Storage } from './storage.js';

/** ไฟล์, โฟลเดอร์, เวอร์ชัน และไฟล์แนบ · งาน A11 (docs/tasks/A11-*.md) */
@Module({
  controllers: [FilesController, StorageController],
  providers: [FilesService, LocalStorage, S3Storage],
  exports: [FilesService],
})
export class FilesModule {}
