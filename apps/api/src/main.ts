import { createApp } from './bootstrap.js';
import { config } from './config.js';

const app = await createApp();
await app.listen(config.port);
console.log(`Friday Manage API · http://localhost:${config.port}/api/v1`);
