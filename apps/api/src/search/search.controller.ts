import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { PatchSavedSearchBody, PatchSavedViewBody, SavedSearchBody, SavedService, SavedViewBody } from './saved.service.js';
import { SearchQuery, SearchService } from './search.service.js';

const Id = z.uuid();

@Controller('w/:ws')
@UseGuards(TenantGuard)
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly saved: SavedService,
  ) {}

  @Get('search')
  find(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Query() query: unknown) {
    return this.search.search(auth, tenant, parse(SearchQuery, query));
  }

  @Get('saved-searches')
  listSearches(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.saved.listSearches(auth, tenant);
  }

  @Post('saved-searches')
  createSearch(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Body() body: unknown) {
    return this.saved.createSearch(auth, tenant, parse(SavedSearchBody, body));
  }

  @Patch('saved-searches/:id')
  patchSearch(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.saved.patchSearch(auth, tenant, parse(Id, id), parse(PatchSavedSearchBody, body));
  }

  @Delete('saved-searches/:id')
  deleteSearch(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string) {
    return this.saved.deleteSearch(auth, tenant, parse(Id, id));
  }

  @Get('projects/:key/saved-views')
  listViews(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.saved.listViews(auth, tenant, key);
  }

  @Post('projects/:key/saved-views')
  createView(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.saved.createView(auth, tenant, key, parse(SavedViewBody, body));
  }

  @Patch('projects/:key/saved-views/:id')
  patchView(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.saved.patchView(auth, tenant, key, parse(Id, id), parse(PatchSavedViewBody, body));
  }

  @Delete('projects/:key/saved-views/:id')
  deleteView(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string) {
    return this.saved.deleteView(auth, tenant, key, parse(Id, id));
  }
}
