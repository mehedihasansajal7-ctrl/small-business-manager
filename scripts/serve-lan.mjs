#!/usr/bin/env node
/**
 * Start the API so a phone on the same Wi-Fi can reach it.
 *
 * `npm run api` binds to 127.0.0.1 (loopback only), which a phone can never
 * reach. Binding to 0.0.0.0 is what makes the Android app able to create an
 * account and sync. Nothing is exposed to the internet by doing this: the
 * address is only reachable from inside your own network, and Windows will ask
 * once for permission when Node first listens.
 *
 * Run with:  npm run api:lan
 */

process.env.HOST = process.env.HOST || '0.0.0.0';
process.env.PORT = process.env.PORT || '8787';

const { createApp, lanAddresses } = await import('../apps/api/dist/server.js');
const { existsSync } = await import('node:fs');
const { join } = await import('node:path');

const dataDir = process.env.DATA_DIR || join(process.cwd(), 'data');
const app = createApp({ host: process.env.HOST, port: Number(process.env.PORT) });
const { port } = await app.start();

const addresses = lanAddresses(port);
console.log('');
console.log('─'.repeat(72));
console.log(' Small Business Manager API is ready for your phone');
console.log('─'.repeat(72));
console.log(` local (this PC)   : http://127.0.0.1:${port}`);
for (const address of addresses) console.log(` from your phone   : ${address}`);
console.log(` web app (browser) : ${addresses[0] ?? `http://127.0.0.1:${port}`}`);
console.log(` database + photos : ${dataDir}`);
console.log('');
console.log(' On the phone: open the app → "Advanced: which server?" → type the');
console.log(' "from your phone" address above → "Test and save this server".');
console.log('');
console.log(' If the phone cannot connect: allow Node.js through the Windows');
console.log(' firewall (an admin PowerShell can run):');
console.log(`   netsh advfirewall firewall add rule name="SBM API ${port}" dir=in action=allow protocol=TCP localport=${port}`);
console.log('─'.repeat(72));
if (!existsSync(join(process.cwd(), 'apps', 'web', 'dist'))) {
  console.log(' (The web app bundle is not built, so only the API is served.)');
}

const shutdown = () => {
  console.log('\nStopping…');
  void app.stop().then(() => {
    // Let the process end on its own: calling process.exit() while the SQLite
    // handle is still closing trips a libuv assertion on Windows.
    process.exitCode = 0;
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
