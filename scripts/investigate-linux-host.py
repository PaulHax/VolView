"""Record host and Chrome scheduling evidence without changing browser flags."""
import json
import pathlib
import sys
import time

output = pathlib.Path(sys.argv[1])
output.parent.mkdir(parents=True, exist_ok=True)

def read(path):
    try:
        return pathlib.Path(path).read_text()
    except (OSError, UnicodeError):
        return None

with output.open("a", buffering=1) as stream:
    while True:
        processes = []
        for proc in pathlib.Path("/proc").iterdir():
            if not proc.name.isdigit():
                continue
            command = read(proc / "cmdline")
            if not command or not any(
                token in command for token in ("chrome", "chromedriver", "wdio")
            ):
                continue
            processes.append({
                "pid": int(proc.name),
                "command": command.replace("\0", " "),
                "stat": read(proc / "stat"),
                "io": read(proc / "io"),
                "status": read(proc / "status"),
            })
        stream.write(json.dumps({
            "time": time.time(),
            "stat": read("/proc/stat"),
            "load": read("/proc/loadavg"),
            "memory": read("/proc/meminfo"),
            "cpu_pressure": read("/proc/pressure/cpu"),
            "io_pressure": read("/proc/pressure/io"),
            "memory_pressure": read("/proc/pressure/memory"),
            "processes": processes,
        }) + "\n")
        time.sleep(2)
