import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const parseProcessType = (commandLine) => {
  const [title = '', ...args] = commandLine?.split('\0') ?? [];
  const titleArgs =
    title.match(/(?:[^\s"'\\]|\\.|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')+/g) ??
    [];
  return (
    [...titleArgs, ...args]
      .map((argument) => argument.match(/^--type=([^\0\s]+)$/)?.[1])
      .find(Boolean) ?? null
  );
};

const read = async (path) => {
  try {
    return { text: await readFile(path, 'utf8'), error: null };
  } catch (error) {
    return { text: null, error: error.code ?? String(error) };
  }
};

const cgroupDirectory = async () => {
  const membership = await read('/proc/self/cgroup');
  const group = membership.text?.match(/^0::(.*)$/m)?.[1];
  const path = group ? resolve('/sys/fs/cgroup', `.${group}`) : null;
  return path &&
    (path === '/sys/fs/cgroup' || path.startsWith('/sys/fs/cgroup/'))
    ? { path, error: null }
    : { path: null, error: membership.error ?? 'No accessible cgroup v2 path' };
};

const processSnapshot = async (rootPid) => {
  try {
    const { stdout } = await run('ps', ['-eo', 'pid=,ppid=,rss=,comm='], {
      timeout: 2000,
    });
    const rows = stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [, pid, ppid, rss, command] = line.match(
          /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/
        );
        return {
          pid: Number(pid),
          ppid: Number(ppid),
          rssKiB: Number(rss),
          command,
        };
      });
    const descendants = new Set([rootPid]);
    for (let size = 0; size !== descendants.size; ) {
      size = descendants.size;
      for (const row of rows) {
        if (descendants.has(row.ppid)) descendants.add(row.pid);
      }
    }
    const processes = await Promise.all(
      rows
        .filter((row) => descendants.has(row.pid))
        .map(async (row) => {
          const commandLine = await read(`/proc/${row.pid}/cmdline`);
          return {
            ...row,
            inChildTree: descendants.has(row.pid),
            chromeType: parseProcessType(commandLine.text),
            commandLineError: commandLine.error,
          };
        })
    );
    return { processes, error: null };
  } catch (error) {
    return { processes: null, error: error.code ?? String(error) };
  }
};

export const startResourceSampling = (file, rootPid) => {
  const output = createWriteStream(file, { flags: 'wx' });
  const write = (record) => output.write(`${JSON.stringify(record)}\n`);
  const group = cgroupDirectory();
  write({
    event: 'metadata',
    timestamp: new Date().toISOString(),
    rootPid,
    intervalMs: 1000,
    rssNote:
      'Only the WDIO child and its descendants are recorded. Process RSS sums can double-count shared memory.',
  });
  let pending = Promise.resolve();
  let busy = false;
  const sample = (event) => {
    if (busy) return pending;
    busy = true;
    pending = (async () => {
      const timestamp = new Date().toISOString();
      const [host, cgroup, processes] = await Promise.all([
        read('/proc/meminfo'),
        group,
        processSnapshot(rootPid),
      ]);
      const available = host.text?.match(/^MemAvailable:\s+(\d+)\s+kB$/m)?.[1];
      const memory = Object.fromEntries(
        await Promise.all(
          ['memory.current', 'memory.max', 'memory.events'].map(
            async (name) => {
              const value = cgroup.path
                ? await read(resolve(cgroup.path, name))
                : { text: null, error: cgroup.error };
              return [
                name,
                { value: value.text?.trim() ?? null, error: value.error },
              ];
            }
          )
        )
      );
      write({
        event,
        timestamp,
        completedAt: new Date().toISOString(),
        hostMemAvailableKiB: available === undefined ? null : Number(available),
        hostMemoryError:
          host.error ??
          (available === undefined ? 'MemAvailable not reported' : null),
        cgroup: { ...cgroup, ...memory },
        ...processes,
        observedRssSumKiB:
          processes.processes?.reduce((sum, row) => sum + row.rssKiB, 0) ??
          null,
      });
    })().finally(() => {
      busy = false;
    });
    return pending;
  };
  void sample('start');
  const timer = setInterval(() => {
    void sample('interval');
  }, 1000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await pending;
    await sample('end');
    output.end();
    await finished(output);
  };
};
