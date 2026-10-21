import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { finished } from 'node:stream/promises';

const adaptive = 'adaptive-labelmap';
const rendering = 'annotation-mints-segment';
const sequences = {
  'adaptive-first': [adaptive, rendering, adaptive],
  'rendering-first': [rendering, adaptive, adaptive],
};
const order = process.argv[2];
const sequence = sequences[order];
if (!sequence) throw new Error(`Unknown test order: ${order}`);

const directory = resolve('.tmp/webgl-startup', order);
if (existsSync(directory)) {
  throw new Error(`Evidence directory already exists: ${directory}`);
}
await mkdir(directory, { recursive: true });
const basePort = Number(process.env.WEBGL_STARTUP_PORT ?? 28460);
if (!Number.isInteger(basePort) || basePort < 1024 || basePort > 65529) {
  throw new Error('WEBGL_STARTUP_PORT must be between 1024 and 65529');
}
const results = [];

for (const [index, name] of sequence.entries()) {
  const phase = `${index + 1}-${name}`;
  const phaseDirectory = resolve(directory, phase);
  await mkdir(phaseDirectory);
  const port = basePort + index * 2;
  const log = createWriteStream(resolve(phaseDirectory, 'wdio.log'));
  const startedAt = new Date().toISOString();
  const spec = `./tests/specs/${name}.e2e.ts`;
  const env = {
    ...process.env,
    VOLVIEW_WEBGL_DIAGNOSTICS: '1',
    VOLVIEW_E2E_PORT: String(port),
    VOLVIEW_E2E_AUX_PORT: String(port + 1),
    WEBGL_STARTUP_SPEC: spec,
    CHROME_LOG_FILE: resolve(phaseDirectory, 'chrome.log'),
  };
  await writeFile(
    resolve(phaseDirectory, 'phase.json'),
    `${JSON.stringify({ order, phase, spec, startedAt, port, display: env.DISPLAY, chromeVersion: env.CHROME_VERSION }, null, 2)}\n`
  );
  const child = spawn(
    process.execPath,
    [
      './node_modules/@wdio/cli/bin/wdio.js',
      'run',
      './wdio.webgl-startup.conf.ts',
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      process.stdout.write(chunk);
      log.write(chunk);
    });
  }
  const outcome = await new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => accept({ code, signal }));
  });
  log.end();
  await finished(log);
  results.push({
    phase,
    spec,
    startedAt,
    completedAt: new Date().toISOString(),
    ...outcome,
    evidence: phaseDirectory,
    testResults: resolve('.tmp/runs', String(port)),
  });
  await writeFile(
    resolve(directory, 'results.json'),
    `${JSON.stringify({ order, results }, null, 2)}\n`
  );
}

process.exitCode = results.some(({ code }) => code !== 0) ? 1 : 0;
