import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type Db } from '@friday/db';
import { config } from './config.js';

export const OPS_DB = Symbol('OPS_DB');

@Global()
@Module({ providers: [{ provide: OPS_DB, useFactory: () => createDb(config.dbUrl, 5) }], exports: [OPS_DB] })
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(OPS_DB) private readonly db: Db) {}
  async onApplicationShutdown() {
    await this.db.$client.end();
  }
}
