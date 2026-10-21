import { statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
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
const diagnosticsEnabled = process.env.WEBGL_STARTUP_DIAGNOSTICS !== '0';
const displayMode = process.env.WEBGL_STARTUP_DISPLAY;
if (
  displayMode !== undefined &&
  displayMode !== 'headless' &&
  displayMode !== 'headed'
) {
  throw new Error('WEBGL_STARTUP_DISPLAY must be headless or headed.');
}
if (
  displayMode === 'headless' &&
  (process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.XAUTHORITY)
) {
  throw new Error('Native headless phases must not inherit a display server.');
}
if (displayMode === 'headed' && !process.env.DISPLAY) {
  throw new Error('Headed phases require an isolated Xvfb display.');
}
const renderer = process.env.WEBGL_STARTUP_RENDERER;
if (
  renderer !== 'automatic' &&
  renderer !== 'swiftshader' &&
  renderer !== 'swiftshader-webgl'
) {
  throw new Error(
    'WEBGL_STARTUP_RENDERER must be automatic, swiftshader or swiftshader-webgl.'
  );
}
if (displayMode && (renderer !== 'swiftshader-webgl' || diagnosticsEnabled)) {
  throw new Error(
    'Display comparisons require swiftshader-webgl with diagnostics disabled.'
  );
}
const phaseDirectory = process.env.WEBGL_STARTUP_PHASE_DIRECTORY;
if (
  !phaseDirectory ||
  !statSync(phaseDirectory, { throwIfNoEntry: false })?.isDirectory()
) {
  throw new Error(
    'WEBGL_STARTUP_PHASE_DIRECTORY must name the evidence directory.'
  );
}

export const config = {
  ...chromeConfig,
  ...(displayMode ? { autoXvfb: false } : {}),
  specs: [resolve(projectRoot(), startupSpec)],
  maxInstances: 1,
  capabilities: chromeConfig.capabilities.map((capability) => {
    const chromeOptions = capability['goog:chromeOptions'];
    const args = chromeOptions.args.filter(
      (argument) => !argument.startsWith('--headless')
    );
    if (
      displayMode === 'headless' ||
      (!displayMode && process.env.HEADLESS === '1')
    ) {
      args.push('--headless=new');
    }
    if (diagnosticsEnabled) args.push('--enable-logging', '--v=1');
    if (renderer !== 'automatic') {
      args.push('--use-gl=angle', `--use-angle=${renderer}`);
    }
    if (args.some((argument) => argument.startsWith('--user-data-dir'))) {
      throw new Error(
        'Each session must use a fresh ChromeDriver-created profile.'
      );
    }

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
  beforeSession: async (_config, capabilities, specs) => {
    await writeFile(
      resolve(phaseDirectory, 'launch.json'),
      `${JSON.stringify({ renderer, displayMode: displayMode ?? null, display: process.env.DISPLAY ?? null, waylandDisplay: process.env.WAYLAND_DISPLAY ?? null, xauthority: process.env.XAUTHORITY ?? null, autoXvfb: _config.autoXvfb ?? null, specs, diagnosticsEnabled, capabilities }, null, 2)}\n`,
      { flag: 'wx' }
    );
  },
  before: [
    async (_capabilities, specs, browser) => {
      await writeFile(
        resolve(phaseDirectory, 'session.json'),
        `${JSON.stringify({ renderer, displayMode: displayMode ?? null, display: process.env.DISPLAY ?? null, specs, sessionId: browser.sessionId, profile: browser.capabilities.chrome?.userDataDir, capabilities: browser.capabilities }, null, 2)}\n`,
        { flag: 'wx' }
      );
      if (diagnosticsEnabled) {
        await installWebGLDiagnostics(browser, TEMP_DIR, specs);
      }
    },
    async (capabilities, specs, browser) => {
      const inheritedHooks = Array.isArray(existingBefore)
        ? existingBefore
        : existingBefore
          ? [existingBefore]
          : [];
      await Promise.all(
        inheritedHooks.map(async (hook) => hook(capabilities, specs, browser))
      );
      if (!displayMode) return;
      const geometry = await browser.execute(() => ({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        devicePixelRatio: window.devicePixelRatio,
        screen: {
          width: window.screen.width,
          height: window.screen.height,
          availWidth: window.screen.availWidth,
          availHeight: window.screen.availHeight,
          colorDepth: window.screen.colorDepth,
          pixelDepth: window.screen.pixelDepth,
        },
      }));
      await writeFile(
        resolve(phaseDirectory, 'viewport.json'),
        `${JSON.stringify({ displayMode, geometry }, null, 2)}\n`,
        { flag: 'wx' }
      );
    },
  ],
} satisfies WebdriverIO.Config;
