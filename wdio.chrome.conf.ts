import { config as sharedConfig, TEMP_DIR } from './wdio.shared.conf';
import { CHROME_VERSION } from './scripts/install-e2e-browser.mjs';

const IS_CI = !!(process.env.CI || process.env.GITHUB_ACTIONS);
const IS_LINUX_CI = IS_CI && process.platform === 'linux';
const IS_HEADLESS = IS_LINUX_CI || process.env.HEADED !== '1';

const chromeArgs: string[] = [];
if (IS_CI) {
  chromeArgs.push(
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-infobars'
  );
}

if (IS_LINUX_CI) {
  chromeArgs.push('--use-gl=angle', '--use-angle=swiftshader-webgl');
}

if (IS_HEADLESS) {
  chromeArgs.push('--headless=new');
}

if (IS_CI || IS_HEADLESS) {
  chromeArgs.push('--enable-unsafe-swiftshader');
}

export const config = {
  ...sharedConfig,
  ...(IS_LINUX_CI ? { autoXvfb: false } : {}),
  capabilities: [
    {
      browserName: 'chrome',
      browserVersion: CHROME_VERSION,
      // this overrides the default chrome download directory with our temporary one
      'goog:chromeOptions': {
        binary: process.env.CHROME_PATH,
        args: chromeArgs,
        prefs: {
          directory_upgrade: true,
          prompt_for_download: false,
          'download.default_directory': TEMP_DIR,
        },
      },
    },
  ],
};
