import { appendFileSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { config as original } from './wdio.chrome.conf';
import { TEMP_DIR } from './wdio.shared.conf';

const pending = new Map<
  string,
  {
    started: number;
    watchdog: ReturnType<typeof setTimeout>;
  }[]
>();
let sampled = false;
type BeforeHook = Exclude<NonNullable<typeof original.before>, unknown[]>;
const record = (event: Record<string, unknown>) => {
  mkdirSync(TEMP_DIR, { recursive: true });
  appendFileSync(
    join(TEMP_DIR, `commands-${process.pid}.jsonl`),
    `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`
  );
};

function sampleChrome(command: string) {
  if (sampled) return;
  sampled = true;
  console.error(`[CI diagnostic] command stalled for 15s: ${command}`);
  if (process.platform !== 'darwin') return;
  execFile('ps', ['-axo', 'pid=,command='], (error, output) => {
    if (error) return console.error(error);
    const chrome = output
      .split('\n')
      .filter(
        (line) =>
          /Google Chrome for Testing/.test(line) && !/crashpad/.test(line)
      );
    record({ event: 'chrome-processes', command, chrome });
    for (const line of chrome.slice(0, 4)) {
      const pid = line.trim().split(/\s+/)[0];
      execFile(
        'sample',
        [
          pid,
          '3',
          '1',
          '-file',
          join(TEMP_DIR, `chrome-stack-${pid}-${Date.now()}.txt`),
        ],
        { timeout: 10000 },
        (failure) => {
          if (failure) console.error(failure.message);
        }
      );
    }
  });
}

export const config = {
  ...original,
  specs: [
    './tests/specs/image-segmentation-sets.e2e.ts',
    './tests/specs/label-outline.e2e.ts',
    './tests/specs/menu-readiness-probe.e2e.ts',
    './tests/specs/slice-display-lifecycle.e2e.ts',
  ],
  maxInstances: 1,
  mochaOpts: {
    ...original.mochaOpts,
    grep: 'Bounded label outlines|Image segmentation sets|CI menu readiness|keeps base and overlay rendering live',
  },
  // These selected cases create synthetic data and need no downloaded datasets.
  onPrepare() {
    mkdirSync(TEMP_DIR, { recursive: true });
  },
  async before(...hookArgs: Parameters<BeforeHook>) {
    for (const hook of [original.before].flat()) await hook?.(...hookArgs);
    await browser.addInitScript(() => {
      const log = (event: string, details = {}) =>
        console.info(
          '[CI diagnostic]',
          JSON.stringify({
            event,
            elapsed: performance.now(),
            url: location.href,
            ...details,
          })
        );
      log('document', { visibility: document.visibilityState });
      document.addEventListener(
        'click',
        (event) => {
          const target = event.target as Element;
          const command = target.closest(
            '[data-testid], .v-list-item, .tool-btn'
          );
          if (!command) return;
          log('click', {
            testid: command.getAttribute('data-testid'),
            text: command.textContent?.trim().slice(0, 80),
          });
        },
        true
      );
      let previous = '';
      new MutationObserver(() => {
        const selectedTab = document.querySelector(
          '#module-switcher [aria-selected="true"]'
        );
        const tool = document.querySelector('.tool-btn-selected');
        const icon = tool?.querySelector('i')?.className;
        const current = `${selectedTab?.getAttribute('data-testid')}:${icon}`;
        if (current === previous) return;
        previous = current;
        log('selection', {
          tab: selectedTab?.getAttribute('data-testid'),
          tool: icon,
        });
      }).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['aria-selected', 'class'],
      });
      if (!new URLSearchParams(location.search).has('axis')) return;
      const getContext = HTMLCanvasElement.prototype.getContext;
      const instrumented = new WeakSet<object>();
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        ...args: any[]
      ) {
        const context = getContext.apply(this, args as any);
        if (
          !context ||
          !String(args[0]).startsWith('webgl') ||
          instrumented.has(context)
        )
          return context;
        instrumented.add(context);
        const gl = context as unknown as WebGL2RenderingContext;
        const renderer = gl.getExtension('WEBGL_debug_renderer_info');
        log('webgl-context', {
          renderer: gl.getParameter(
            renderer?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER
          ),
        });
        this.addEventListener('webglcontextlost', (event) =>
          log('context-lost', {
            status: (event as WebGLContextEvent).statusMessage,
          })
        );
        for (const name of [
          'compileShader',
          'linkProgram',
          'drawArrays',
          'drawElements',
          'readPixels',
        ] as const) {
          const invoke = gl[name].bind(gl) as (...values: any[]) => any;
          (gl[name] as any) = (...values: any[]) => {
            const start = performance.now();
            log(`${name}-begin`);
            const result = invoke(...values);
            log(`${name}-end`, { duration: performance.now() - start });
            return result;
          };
        }
        return context;
      } as typeof getContext;
    });
  },
  beforeCommand(command: string) {
    record({ event: 'command-begin', command });
    const entries = pending.get(command) ?? [];
    entries.push({
      started: Date.now(),
      watchdog: setTimeout(() => sampleChrome(command), 15000),
    });
    pending.set(command, entries);
  },
  async afterCommand(
    command: string,
    args: unknown[],
    result: unknown,
    error?: Error
  ) {
    const entry = pending.get(command)?.pop();
    clearTimeout(entry?.watchdog);
    record({
      event: 'command-end',
      command,
      duration: entry ? Date.now() - entry.started : undefined,
      error: error ? String(error) : undefined,
    });
    for (const hook of [original.afterCommand].flat())
      await hook?.(command, args, result, error);
  },
};
