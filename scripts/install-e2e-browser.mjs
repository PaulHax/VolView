import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, install } from '@puppeteer/browsers';

export const CHROME_VERSION = '157.0.8103.26';

export async function installBrowserPair(
  cacheDir = resolve('.tmp/e2e-browsers')
) {
  const options = { buildId: CHROME_VERSION, cacheDir };
  const chrome = await install({ ...options, browser: Browser.CHROME });
  const driver = await install({ ...options, browser: Browser.CHROMEDRIVER });
  for (const binary of [chrome, driver]) {
    const actual = execFileSync(binary.executablePath, ['--version'], {
      encoding: 'utf8',
    }).trim();
    if (!actual.includes(CHROME_VERSION)) {
      throw new Error(`Expected ${CHROME_VERSION}, received ${actual}`);
    }
    console.info(actual);
  }
  const environment =
    `CHROME_PATH=${chrome.executablePath}\n` +
    `CHROMEDRIVER_PATH=${driver.executablePath}\n`;
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, environment);
  } else {
    process.stdout.write(environment);
  }
  return { chrome: chrome.executablePath, driver: driver.executablePath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  installBrowserPair().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
