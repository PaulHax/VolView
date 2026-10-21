import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { startResourceSampling } from './sample-webgl-resources.mjs';

const sequences = {
  'automatic-first': ['automatic', 'swiftshader'],
  'swiftshader-first': ['swiftshader', 'automatic'],
  'driver-first': ['swiftshader', 'swiftshader-webgl'],
  'webgl-first': ['swiftshader-webgl', 'swiftshader'],
};
const order = process.argv[2];
if (!Object.hasOwn(sequences, order)) {
  throw new Error(`Unknown renderer order: ${order}`);
}
const sequence = sequences[order];

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
const profiles = new Set();
const spec =
  process.env.WEBGL_STARTUP_SPEC ??
  './tests/specs/annotation-mints-segment.e2e.ts';

for (const [index, renderer] of sequence.entries()) {
  const phase = `${index + 1}-${renderer}`;
  const phaseDirectory = resolve(directory, phase);
  await mkdir(phaseDirectory);
  const port = basePort + index * 2;
  const log = createWriteStream(resolve(phaseDirectory, 'wdio.log'));
  const startedAt = new Date().toISOString();
  const env = {
    ...process.env,
    VOLVIEW_WEBGL_DIAGNOSTICS: '1',
    VOLVIEW_E2E_PORT: String(port),
    VOLVIEW_E2E_AUX_PORT: String(port + 1),
    WEBGL_STARTUP_SPEC: spec,
    WEBGL_STARTUP_RENDERER: renderer,
    WEBGL_STARTUP_PHASE_DIRECTORY: phaseDirectory,
    CHROME_LOG_FILE: resolve(phaseDirectory, 'chrome.log'),
  };
  await writeFile(
    resolve(phaseDirectory, 'phase.json'),
    `${JSON.stringify({ order, phase, renderer, spec, startedAt, port, display: env.DISPLAY, chromeVersion: env.CHROME_VERSION, runnerImage: { os: env.ImageOS, version: env.ImageVersion } }, null, 2)}\n`
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
  const stopSampling = startResourceSampling(
    resolve(phaseDirectory, 'resources.jsonl'),
    child.pid
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
  }).finally(stopSampling);
  log.end();
  await finished(log);
  const sessionPath = resolve(phaseDirectory, 'session.json');
  const session = existsSync(sessionPath)
    ? JSON.parse(await readFile(sessionPath, 'utf8'))
    : null;
  const profile = session?.profile;
  const profileVerified = typeof profile === 'string' && !profiles.has(profile);
  if (profile) profiles.add(profile);
  results.push({
    phase,
    renderer,
    spec,
    startedAt,
    completedAt: new Date().toISOString(),
    ...outcome,
    profile,
    profileVerified,
    evidence: phaseDirectory,
    testResults: resolve('.tmp/runs', String(port)),
  });
  await writeFile(
    resolve(directory, 'results.json'),
    `${JSON.stringify({ order, results }, null, 2)}\n`
  );
}

process.exitCode = results.some(
  ({ code, profileVerified }) => code !== 0 || !profileVerified
)
  ? 1
  : 0;
