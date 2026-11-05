import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type Db } from '@friday/db';
import { config } from '../config.js';

export const APP_DB = Symbol('APP_DB');
export const SYSTEM_DB = Symbol('SYSTEM_DB');

@Global()
@Module({
  providers: [
    { provide: APP_DB, useFactory: () => createDb(config.appDbUrl) },
    { provide: SYSTEM_DB, useFactory: () => createDb(config.systemDbUrl, 5) },
  ],
  exports: [APP_DB, SYSTEM_DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(
    @Inject(APP_DB) private readonly appDb: Db,
    @Inject(SYSTEM_DB) private readonly systemDb: Db,
  ) {}

  async onApplicationShutdown() {
    await Promise.all([this.appDb.$client.end(), this.systemDb.$client.end()]);
  }
}
