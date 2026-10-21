import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as chromeConfig } from './wdio.chrome.conf';
import { TEMP_DIR } from './wdio.shared.conf';
import { projectRoot } from './tests/e2eTestUtils';
import { installWebGLDiagnostics } from './tests/webglDiagnostics';

const startupSpec = process.env.WEBGL_STARTUP_SPEC;
if (
  !startupSpec ||
  !startupSpec.endsWith('.e2e.ts') ||
  !statSync(resolve(projectRoot(), startupSpec), {
    throwIfNoEntry: false,
  })?.isFile()
) {
  throw new Error('WEBGL_STARTUP_SPEC must name an existing E2E spec file.');
}

const existingBefore = chromeConfig.before;

export const config = {
  ...chromeConfig,
  specs: [resolve(projectRoot(), startupSpec)],
  maxInstances: 1,
  capabilities: chromeConfig.capabilities.map((capability) => {
    const chromeOptions = capability['goog:chromeOptions'];
    const args = chromeOptions.args.filter(
      (argument) => !argument.startsWith('--headless')
    );
    if (process.env.HEADLESS === '1') args.push('--headless=new');
    args.push('--enable-logging', '--v=1');

    return {
      ...capability,
      ...(process.env.CHROME_VERSION
        ? { browserVersion: process.env.CHROME_VERSION }
        : {}),
      'goog:chromeOptions': {
        ...chromeOptions,
        args,
        ...(process.env.CHROME_BINARY
          ? { binary: process.env.CHROME_BINARY }
          : {}),
      },
    };
  }),
  before: [
    async (_capabilities, specs, browser) => {
      await installWebGLDiagnostics(browser, TEMP_DIR, specs);
    },
    ...(Array.isArray(existingBefore)
      ? existingBefore
      : existingBefore
        ? [existingBefore]
        : []),
  ],
} satisfies WebdriverIO.Config;
