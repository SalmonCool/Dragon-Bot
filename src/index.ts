// Must be first: ESM evaluates imports depth-first, so any module below that reads
// process.env at module scope would otherwise run before .env is parsed.
import 'dotenv/config';

import { startBot } from './bot/client.js';
import { webSettings } from './config.js';
import { startWebServer } from './web/server.js';

const client = await startBot();

const web = webSettings();
const webServer = web ? startWebServer(web) : undefined;
if (!web) {
  console.log('Web UI disabled (set WEB_PASSWORD in .env to enable).');
}

/**
 * Clean shutdown matters more than usual here: later phases spawn ffmpeg children
 * and hold a voice connection, and systemd will SIGTERM this process on restart.
 * Establishing the hook now means those teardown steps have somewhere to live.
 */
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down.`);
    webServer?.close();
    void client.destroy().finally(() => process.exit(0));
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
