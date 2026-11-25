const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { relative, resolve, sep } = require('node:path');

const root = resolve(__dirname, '..');
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };

async function run() {
  await app.whenReady();
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const file = resolve(root, `.${pathname}`);
      const rel = relative(root, file);
      if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || rel.startsWith(sep)) {
        response.writeHead(404).end(); return;
      }
      const body = await readFile(file);
      const extension = file.slice(file.lastIndexOf('.'));
      response.writeHead(200, {
        'Content-Type': mimeTypes[extension] || 'application/octet-stream',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'none'",
        'X-Content-Type-Options': 'nosniff',
      }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const window = new BrowserWindow({
    show: false, width: 1, height: 1,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    await window.loadURL(`http://127.0.0.1:${address.port}/tests/signalsmith-stretch.html`);
    const result = await Promise.race([
      window.webContents.executeJavaScript('window.__stretchSmokePromise'),
      new Promise(resolveTimeout => setTimeout(() => resolveTimeout({ ok: false, error: 'Signalsmith audio smoke timed out' }), 30_000)),
    ]);
    if (!result?.ok) throw new Error(`Signalsmith audio smoke failed: ${JSON.stringify(result)}`);
    console.log(`Signalsmith audio smoke passed: ${result.inputFrames} → ${result.outputFrames} frames, ${result.frequency.toFixed(2)} Hz, RMS ${result.rms.toFixed(3)}`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  } finally {
    server.close();
  }
}

run().catch(error => { console.error(error); app.exit(1); });
