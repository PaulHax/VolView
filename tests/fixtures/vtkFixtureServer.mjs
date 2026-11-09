import { mkdtemp, rm } from 'node:fs/promises';
import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

export async function startVtkFixture(directory) {
  const cacheDir = await mkdtemp(resolve(tmpdir(), 'vtk-fixture-'));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const diagnosticDir = process.env.CI_FIXTURE_DIAGNOSTIC_DIR;
  const traceRequests =
    diagnosticDir && fileURLToPath(directory).includes('label-outline');
  const requestLog = traceRequests
    ? resolve(diagnosticDir, `fixture-${process.pid}.jsonl`)
    : null;
  let recordFailed = false;
  let nextRequest = 0;
  const record = (event) => {
    if (!requestLog || recordFailed) return;
    try {
      mkdirSync(diagnosticDir, { recursive: true });
      appendFileSync(
        requestLog,
        `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`
      );
    } catch (error) {
      recordFailed = true;
      console.error('[CI diagnostic] fixture request log write failed:', error);
    }
  };
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(directory),
    cacheDir,
    resolve: { alias: { '@': root } },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
    plugins: requestLog
      ? [
          {
            name: 'ci-outline-request-log',
            configureServer(vite) {
              vite.middlewares.use((request, response, next) => {
                const id = ++nextRequest;
                const start = Date.now();
                record({ event: 'request-start', id, url: request.url });
                response.once('finish', () =>
                  record({
                    event: 'request-finish',
                    id,
                    status: response.statusCode,
                    duration: Date.now() - start,
                  })
                );
                response.once('close', () => {
                  if (!response.writableFinished)
                    record({ event: 'request-aborted', id });
                });
                next();
              });
            },
          },
        ]
      : [],
  });
  await server.listen();
  return {
    url: server.resolvedUrls.local[0],
    async close() {
      await server.close();
      await rm(cacheDir, { recursive: true, force: true });
    },
  };
}
