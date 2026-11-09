import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { execFile } from 'node:child_process';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { config as original } from './wdio.chrome.conf';
import { TEMP_DIR } from './wdio.shared.conf';

let nextCommand = 0;
const originalPrefix = process.env.CI_ORIGINAL_PREFIX === '1';
const lifecycleOnly = process.env.CI_LIFECYCLE_ONLY === '1';
const outlineStress = process.env.CI_OUTLINE_STRESS === '1';
const prefixSpecs = readdirSync('tests/specs')
  .filter((name) => name.endsWith('.e2e.ts') && name <= 'label-outline.e2e.ts')
  .sort()
  .map((name) => `./tests/specs/${name}`);
let sampled = false;
let recordFailed = false;
type BeforeHook = Exclude<NonNullable<typeof original.before>, unknown[]>;
const record = (event: Record<string, unknown>) => {
  if (recordFailed) return;
  try {
    mkdirSync(TEMP_DIR, { recursive: true });
    appendFileSync(
      join(TEMP_DIR, `commands-${process.pid}.jsonl`),
      `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`
    );
  } catch (error) {
    recordFailed = true;
    console.error('[CI diagnostic] command log write failed:', error);
  }
};

async function traceCommand<T>(command: string, invoke: () => Promise<T>) {
  const id = ++nextCommand;
  const started = Date.now();
  record({ event: 'command-begin', command, id });
  const timer = setTimeout(() => sampleChrome(command), 15000);
  try {
    return await invoke();
  } catch (error) {
    record({ event: 'command-error', command, id, error: String(error) });
    throw error;
  } finally {
    clearTimeout(timer);
    record({
      event: 'command-end',
      command,
      id,
      duration: Date.now() - started,
    });
  }
}

function sampleChrome(command: string) {
  if (sampled) return;
  sampled = true;
  console.error(`[CI diagnostic] command stalled for 15s: ${command}`);
  if (process.platform !== 'darwin') return;
  // Distinguish renderer/GPU work from a runner disk fault or global starvation.
  for (const [name, executable, args] of [
    ['processes', 'ps', ['-axo', 'pid,ppid,stat,pcpu,pmem,etime,command']],
    ['memory', 'vm_stat', []],
    ['disk-space', 'df', ['-h']],
    [
      'kernel',
      '/usr/bin/log',
      [
        'show',
        '--last',
        '10m',
        '--style',
        'compact',
        '--predicate',
        'process == "kernel" AND (eventMessage CONTAINS[c] "I/O error" OR eventMessage CONTAINS[c] "apfs" OR eventMessage CONTAINS[c] "GPU")',
      ],
    ],
  ] as const) {
    execFile(
      executable,
      [...args],
      { timeout: 10000, maxBuffer: 8 * 1024 * 1024 },
      (failure, output, stderr) => {
        try {
          writeFileSync(
            join(TEMP_DIR, `stall-${name}-${process.pid}.txt`),
            `${output}\n${stderr}\n${failure?.message ?? ''}`
          );
          record({
            event: 'host-snapshot',
            command,
            name,
            error: failure?.message,
          });
        } catch (error) {
          console.error(
            `[CI diagnostic] ${name} snapshot write failed:`,
            error
          );
        }
      }
    );
  }
  execFile(
    'ps',
    ['-axo', 'pid=,command='],
    { timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
    (error, output) => {
      if (error) return console.error(error);
      const chrome = output
        .split('\n')
        .filter(
          (line) =>
            /Google Chrome for Testing/.test(line) && !/crashpad/.test(line)
        );
      record({ event: 'chrome-processes', command, chrome });
      // Process order is not a role order: the renderer may be fifth or later.
      for (const line of chrome) {
        const pid = line.trim().split(/\s+/)[0];
        const samplePath = join(
          TEMP_DIR,
          `chrome-stack-${pid}-${Date.now()}.txt`
        );
        execFile(
          'sample',
          [pid, '3', '1', '-file', samplePath],
          { timeout: 10000 },
          (failure) => {
            if (failure) console.error(failure.message);
            else {
              try {
                console.info(
                  `[CI diagnostic] native sample ${pid}\n${readFileSync(samplePath, 'utf8').split('\n').slice(0, 250).join('\n')}`
                );
              } catch (sampleError) {
                console.error(
                  `[CI diagnostic] native sample ${pid} read failed:`,
                  sampleError
                );
              }
            }
          }
        );
      }
    }
  );
}

export const config = {
  ...original,
  specs: outlineStress
    ? ['./tests/specs/label-outline.e2e.ts']
    : lifecycleOnly
      ? ['./tests/specs/slice-display-lifecycle.e2e.ts']
      : originalPrefix
        ? prefixSpecs
        : [
            './tests/specs/image-segmentation-sets.e2e.ts',
            './tests/specs/label-outline.e2e.ts',
            './tests/specs/menu-readiness-probe.e2e.ts',
            './tests/specs/slice-display-lifecycle.e2e.ts',
          ],
  maxInstances: 1,
  mochaOpts: {
    ...original.mochaOpts,
    ...(outlineStress
      ? { bail: true, grep: 'Bounded label outlines' }
      : lifecycleOnly
        ? { grep: 'Slice display lifecycle' }
        : originalPrefix
          ? { bail: true }
          : {
              grep: 'Bounded label outlines|Image segmentation sets|CI menu readiness|keeps base and overlay rendering live',
            }),
  },
  // These selected cases create synthetic data and need no downloaded datasets.
  onPrepare: originalPrefix
    ? original.onPrepare
    : function prepareSyntheticData() {
        mkdirSync(TEMP_DIR, { recursive: true });
      },
  beforeTest(test: { title: string }) {
    record({ event: 'test-start', title: test.title });
  },
  async before(...hookArgs: Parameters<BeforeHook>) {
    const processors = cpus();
    record({
      event: 'worker-environment',
      platform: process.platform,
      architecture: process.arch,
      processors: processors.length,
      models: [...new Set(processors.map(({ model }) => model))],
      chrome: browser.capabilities.browserVersion,
    });
    for (const command of [
      'execute',
      'executeAsync',
      'url',
      'saveScreenshot',
    ] as const) {
      browser.overwriteCommand(command, (invoke, ...parameters) =>
        traceCommand(command, () =>
          (invoke as (...values: any[]) => Promise<any>)(...parameters)
        )
      );
    }
    for (const hook of [original.before].flat()) await hook?.(...hookArgs);
    // Keep the original page free of observer/WebGL wrappers in the pristine replay.
    if (process.env.CI_NO_PAGE_INSTRUMENTATION === '1') return;
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
      const traceGlCalls = new URLSearchParams(location.search).has('axis');
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
        if (!traceGlCalls) return context;
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
};
