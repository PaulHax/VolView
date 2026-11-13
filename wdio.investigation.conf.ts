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
  .filter((name) => name.endsWith('.e2e.ts') && name <=
    (process.env.CI_LIFECYCLE_PREFIX === '1'
      ? 'slice-display-lifecycle.e2e.ts'
      : 'label-outline.e2e.ts'))
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

function describeScript(script: unknown): Record<string, unknown> {
  try {
    const source = typeof script === 'function'
      ? Function.prototype.toString.call(script)
      : typeof script === 'string' ? script : undefined;
    if (source === undefined) return {};
    return {
      scriptSource: source.slice(0, 8192),
      scriptSourceLength: source.length,
      scriptSourceTruncated: source.length > 8192,
    };
  } catch (error) {
    return { scriptCaptureError: String(error) };
  }
}

async function traceCommand<T>(
  command: string,
  invoke: () => Promise<T>,
  details: Record<string, unknown> = {}
) {
  const id = ++nextCommand;
  const started = Date.now();
  record({
    event: 'command-begin', command, id, ...details,
    caller: new Error().stack?.split('\n').slice(2, 10),
  });
  const nativeLinux = process.env.CI_LINUX_NATIVE === '1' &&
    process.env.CI_LINUX_NATIVE_STALL !== '1';
  const sampleThis = !nativeLinux ||
    (command === 'element.click' && details.selector === '.v-list-item-title=3D Only');
  const timer = sampleThis
    ? setTimeout(() => sampleChrome(command, id), nativeLinux ? 5000 : 15000)
    : undefined;
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

function sampleLinuxCommand(command: string, id?: number) {
  const root = Number(browser.capabilities['goog:processID']);
  if (!Number.isSafeInteger(root) || root <= 0) {
    record({ event: 'linux-stall-target-error', command, id, error: 'Missing Chrome browser PID' });
    return;
  }
  execFile('ps', ['-axo', 'pid=,ppid=,args='],
    { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, output) => {
      if (error) {
        record({ event: 'linux-stall-target-error', command, id, error: error.message });
        return;
      }
      const processes = output.split('\n').flatMap(line => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        return match ? [{ pid: Number(match[1]), parent: Number(match[2]), args: match[3] }] : [];
      });
      const family = new Set([root]);
      for (let changed = true; changed;) {
        changed = false;
        for (const entry of processes) {
          if (family.has(entry.parent) && !family.has(entry.pid)) {
            family.add(entry.pid);
            changed = true;
          }
        }
      }
      const targets = processes.filter(entry => family.has(entry.pid))
        .flatMap(entry => {
          const role = entry.pid === root ? 'browser'
            : /--type=gpu-process(?:\s|$)/.test(entry.args) ? 'gpu'
              : /--type=renderer(?:\s|$)/.test(entry.args) ? 'renderer' : undefined;
          return role ? [{ ...entry, role }] : [];
        }).sort((a, b) => {
          const rank: Record<string, number> = { browser: 0, gpu: 1, renderer: 2 };
          return rank[a.role] - rank[b.role] || a.pid - b.pid;
        });
      record({ event: 'linux-stall-targets', command, id, root, targets,
        omitted: Math.max(0, targets.length - 8) });
      // Capture only this WDIO session's browser/GPU/renderers, once per worker.
      for (const { pid, role } of targets.slice(0, 8)) {
        record({ event: 'linux-stall-sample-begin', command, id, pid, role });
        execFile('sudo', ['-n', 'gdb', '--batch', '--nx', '--nh',
          '-iex', 'set auto-load off', '-iex', 'set debuginfod enabled off',
          '-ex', 'set pagination off', '-ex', 'info threads',
          '-ex', 'thread apply all bt 12', '-ex', 'info sharedlibrary',
          '-ex', 'info proc mappings', '-ex', 'thread apply all x/8i $pc',
          '-p', String(pid)],
          { timeout: 10000, maxBuffer: 8 * 1024 * 1024 },
          (failure, stdout, stderr) => {
            record({ event: 'linux-stall-sample-end', command, id, pid, role,
              error: failure?.message });
            try {
              writeFileSync(join(TEMP_DIR, `native-${process.pid}-${id}-${role}-${pid}.txt`),
                `${stdout}\n${stderr}\n${failure?.message ?? ''}`);
            } catch (writeError) { console.error(writeError); }
          });
      }
    });
}

function sampleChrome(command: string, id?: number) {
  if (sampled) return;
  sampled = true;
  console.error(`[CI diagnostic] command unfinished at native sampling threshold: ${command}`);
  if (process.platform === 'linux' && process.env.CI_LINUX_NATIVE_STALL === '1') {
    sampleLinuxCommand(command, id);
    return;
  }
  if (process.platform === 'linux' && process.env.CI_LINUX_NATIVE === '1') {
    execFile('ps', ['-axo', 'pid=,command='],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, output) => {
        if (error) return console.error(error);
        const gpu = output.split('\n').filter(line =>
          /chrome.*--type=gpu-process/.test(line) &&
          !/gdb|sudo/.test(line)
        );
        record({ event: 'linux-native-targets', command, gpu });
        for (const line of gpu) {
          const pid = line.trim().split(/\s+/)[0];
          execFile('sudo', ['-n', 'gdb', '--batch', '--nx', '--nh',
            '-iex', 'set auto-load off',
            '-iex', 'set debuginfod enabled off',
            '-ex', 'set pagination off',
            '-ex', 'info threads',
            '-ex', 'thread apply all bt 12',
            '-ex', 'info sharedlibrary',
            '-ex', 'info proc mappings',
            '-ex', 'thread apply all x/8i $pc', '-p', pid],
            { timeout: 10000, maxBuffer: 8 * 1024 * 1024 },
            (failure, stdout, stderr) => {
              record({ event: 'linux-native-sample', pid, error: failure?.message });
              try {
                writeFileSync(join(TEMP_DIR, `gpu-stack-${pid}.txt`),
                  `${stdout}\n${stderr}\n${failure?.message ?? ''}`);
              } catch (writeError) { console.error(writeError); }
            });
        }
      });
    return;
  }
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
  async after(...hookArgs: Parameters<Exclude<NonNullable<typeof original.after>, unknown[]>>) {
    // Query only after the spec, so GPU collection cannot warm up the test page.
    if (process.env.CI_BROWSER_GPU_INFO === '1') {
      try {
        const { captureBrowserGpuInfo } = await import('./scripts/investigate-browser-gpu.mjs');
        const options = browser.capabilities['goog:chromeOptions'] as { debuggerAddress?: string } | undefined;
        const info = await captureBrowserGpuInfo(options?.debuggerAddress);
        record({ event: 'browser-gpu-info', ...info });
      } catch (error) {
        record({ event: 'browser-gpu-info-error', error: String(error) });
      }
    }
    for (const hook of [original.after].flat()) await hook?.(...hookArgs);
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
          (invoke as (...values: any[]) => Promise<any>)(...parameters),
          command === 'execute' || command === 'executeAsync'
            ? describeScript(parameters[0])
            : {}
        )
      );
    }
    if (process.env.CI_LIFECYCLE_COMMANDS === '1') {
      for (const command of [
        'click', 'doubleClick', 'moveTo', 'scrollIntoView',
        'waitForStable', 'waitForDisplayed', 'waitForClickable',
      ] as const) {
        browser.overwriteCommand(command, function (invoke, ...parameters) {
          return traceCommand(
            `element.${command}`,
            () => (invoke as (...values: any[]) => Promise<any>)(...parameters),
            { selector: String(this.selector) }
          );
        }, true);
      }
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
