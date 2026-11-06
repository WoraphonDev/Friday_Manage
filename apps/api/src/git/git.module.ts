import { Module } from '@nestjs/common';
import { GitEventsService } from './git-events.js';
import { GithubApi } from './github-api.js';
import { GitIntegrationsController, GithubHooksController, IssueGitController, ProjectReposController } from './git.controller.js';
import { GitService } from './git.service.js';

/** เชื่อม GitHub: Commit / PR กับงาน · งาน A27 (docs/tasks/A27-*.md) */
@Module({
  controllers: [GitIntegrationsController, ProjectReposController, IssueGitController, GithubHooksController],
  providers: [GitService, GitEventsService, GithubApi],
})
export class GitModule {}
