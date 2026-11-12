import { Module } from '@nestjs/common';
import { DeletedWorkspaceService } from './deleted-workspace.service.js';
import { TrashPurgeService } from './purge.service.js';
import { DeletedWorkspaceController, ProjectTrashController, TrashController } from './trash.controller.js';
import { TrashService } from './trash.service.js';

/** ถังขยะ กู้คืนโปรเจกต์ ลบถาวรตามกำหนด และหน้า Workspace ที่ลบไว้ · งาน A41 (docs/tasks/A41-trash-restore.md) */
@Module({
  controllers: [TrashController, ProjectTrashController, DeletedWorkspaceController],
  providers: [TrashService, TrashPurgeService, DeletedWorkspaceService],
  exports: [TrashService],
})
export class TrashModule {}
