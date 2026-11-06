import { config } from './config.js';
import { createApp } from './bootstrap.js';

const app = await createApp();
await app.listen(config.port);
console.log(`ops-api listening on :${config.port}`);
