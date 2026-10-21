import { config as chromeConfig } from './wdio.chrome.conf';

export const config = {
  ...chromeConfig,
  capabilities: chromeConfig.capabilities.map((capability) => ({
    ...capability,
    ...(process.env.CHROME_VERSION
      ? { browserVersion: process.env.CHROME_VERSION }
      : {}),
    'goog:chromeOptions': {
      ...capability['goog:chromeOptions'],
      args: [
        ...capability['goog:chromeOptions'].args,
        '--use-gl=angle',
        '--use-angle=swiftshader',
      ],
      ...(process.env.CHROME_BINARY
        ? { binary: process.env.CHROME_BINARY }
        : {}),
    },
  })),
} satisfies WebdriverIO.Config;
