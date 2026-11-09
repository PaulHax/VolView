import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import https from 'node:https';
import { resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import { setupBrowser } from '@wdio/utils/node';
import {
  Browser,
  computeExecutablePath,
  detectBrowserPlatform,
} from '@puppeteer/browsers';
import { CHROME_VERSION } from './install-e2e-browser.mjs';

// Reproduce the recorded availability-check failure with an installed browser.
// Fail only HEAD requests to the public browser archive; make no network calls.
const cacheDir = resolve('.tmp/e2e-browsers');
const binary = computeExecutablePath({
  cacheDir,
  browser: Browser.CHROME,
  platform: detectBrowserPlatform(),
  buildId: CHROME_VERSION,
});
assert.ok(existsSync(binary), `Install the pinned browser first: ${binary}`);
const previousDriver = process.env.CHROMEDRIVER_PATH;
delete process.env.CHROMEDRIVER_PATH;
let rejectedProbes = 0;
const request = https.request;
mock.method(https, 'request', (options, ...args) => {
  if (
    options.method !== 'HEAD' ||
    options.hostname !== 'storage.googleapis.com'
  )
    return request.call(https, options, ...args);
  rejectedProbes++;
  const pending = new EventEmitter();
  pending.end = () => {
    process.nextTick(() =>
      pending.emit(
        'error',
        Object.assign(new Error('Injected connection reset'), {
          code: 'ECONNRESET',
        })
      )
    );
  };
  return pending;
});
syncBuiltinESMExports();

try {
  const capabilities = {
    browserName: 'chrome',
    browserVersion: CHROME_VERSION,
  };
  await assert.rejects(
    setupBrowser({ cacheDir }, [{ ...capabilities }]),
    /Couldn't find a matching chrome browser/
  );
  assert.equal(rejectedProbes, 1);
  console.info('CONTROL: cached Chrome rejected after a failed HEAD request');
  const installed = await setupBrowser({ cacheDir }, [
    {
      ...capabilities,
      'goog:chromeOptions': { binary },
    },
  ]);
  assert.equal(installed[0].executablePath, binary);
  assert.equal(rejectedProbes, 1);
  console.info(
    'FIXED: explicit Chrome path succeeds without another HEAD request'
  );
} finally {
  mock.restoreAll();
  syncBuiltinESMExports();
  if (previousDriver !== undefined)
    process.env.CHROMEDRIVER_PATH = previousDriver;
}
