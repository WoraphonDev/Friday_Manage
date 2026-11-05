// I. Git · repository เป็นของ Workspace ส่วนการผูกงานต้องผ่านสิทธิ์โปรเจกต์
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tstz, updatedAt } from './_common.ts';
import { users } from './identity.ts';
import { issues } from './issue.ts';
import { inProject, workflowStatuses, workspaceId } from './project.ts';
import { tenantFk, tenantKey } from './saas-common.ts';
import { gitLinkSource, gitProvider, pullRequestState } from './saas-enums.ts';

export const gitInstallations = pgTable('git_installations', {
  id: pk(), workspaceId: workspaceId(),
  provider: gitProvider().notNull(),
  accountName: text().notNull(),
  externalInstallationId: text().notNull(),
  status: text().notNull().default('active'),
  accessTokenEncrypted: text(), accessTokenLast4: text(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [tenantKey('git_installations', t), uniqueIndex('git_installations_external_key').on(t.provider, t.externalInstallationId)]);

export const gitRepositories = pgTable('git_repositories', {
  id: pk(), workspaceId: workspaceId(), installationId: uuid().notNull(),
  fullName: text().notNull(), defaultBranch: text().notNull().default('main'),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [tenantKey('git_repositories', t), tenantFk('git_repositories_installation_fk', t.workspaceId, t.installationId, gitInstallations).onDelete('cascade'), uniqueIndex('git_repositories_name_key').on(t.installationId, t.fullName)]);

export const projectRepositories = pgTable('project_repositories', {
  id: pk(), workspaceId: workspaceId(), projectId: uuid().notNull(), repositoryId: uuid().notNull(),
  branchPattern: text(),
  onFirstCommitStatusId: uuid(), onPrOpenStatusId: uuid(), onMergeStatusId: uuid(),
  notifyOnCiFail: boolean().notNull().default(true),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [inProject('project_repositories', t), tenantFk('project_repositories_repository_fk', t.workspaceId, t.repositoryId, gitRepositories).onDelete('cascade'),
  tenantFk('project_repositories_commit_status_fk', t.workspaceId, t.onFirstCommitStatusId, workflowStatuses),
  tenantFk('project_repositories_pr_status_fk', t.workspaceId, t.onPrOpenStatusId, workflowStatuses),
  tenantFk('project_repositories_merge_status_fk', t.workspaceId, t.onMergeStatusId, workflowStatuses),
  uniqueIndex('project_repositories_key').on(t.projectId, t.repositoryId)]);

export const gitCommits = pgTable('git_commits', {
  id: pk(), workspaceId: workspaceId(), repositoryId: uuid().notNull(),
  sha: text().notNull(), message: text().notNull(), authorName: text(),
  authorUserId: uuid().references(() => users.id), committedAt: tstz().notNull(), url: text().notNull(),
  createdAt: createdAt(),
}, (t) => [tenantKey('git_commits', t), tenantFk('git_commits_repository_fk', t.workspaceId, t.repositoryId, gitRepositories).onDelete('cascade'), uniqueIndex('git_commits_sha_key').on(t.repositoryId, t.sha)]);

export const pullRequests = pgTable('pull_requests', {
  id: pk(), workspaceId: workspaceId(), repositoryId: uuid().notNull(),
  number: integer().notNull(), title: text().notNull(), state: pullRequestState().notNull().default('open'),
  sourceBranch: text().notNull(), targetBranch: text().notNull(), ciStatus: text(), reviewStatus: text(), url: text().notNull(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [tenantKey('pull_requests', t), tenantFk('pull_requests_repository_fk', t.workspaceId, t.repositoryId, gitRepositories).onDelete('cascade'), uniqueIndex('pull_requests_number_key').on(t.repositoryId, t.number), check('pull_requests_number_positive', sql`${t.number} > 0`)]);

export const issueGitLinks = pgTable('issue_git_links', {
  id: pk(), workspaceId: workspaceId(), issueId: uuid().notNull(), commitId: uuid(), pullRequestId: uuid(),
  linkSource: gitLinkSource().notNull(), createdAt: createdAt(),
}, (t) => [tenantFk('issue_git_links_issue_fk', t.workspaceId, t.issueId, issues).onDelete('cascade'),
  tenantFk('issue_git_links_commit_fk', t.workspaceId, t.commitId, gitCommits).onDelete('cascade'),
  tenantFk('issue_git_links_pr_fk', t.workspaceId, t.pullRequestId, pullRequests).onDelete('cascade'),
  check('issue_git_links_one_target', sql`num_nonnulls(${t.commitId}, ${t.pullRequestId}) = 1`),
  uniqueIndex('issue_git_links_commit_key').on(t.issueId, t.commitId), uniqueIndex('issue_git_links_pr_key').on(t.issueId, t.pullRequestId),
  index('issue_git_links_issue_idx').on(t.issueId)]);
