import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeStateReadCommand } from "../src/core/tmux-poll.js";
import {
  buildContainerGitStatusScript,
  CONTAINER_FILE_TREE_LISTER,
  MAX_FILE_TREE_NODES,
} from "../src/core/commands-files.js";
import { quoteShell } from "../src/core/commands-agent-support.js";

/**
 * What one container `docker exec` costs, end to end, on the Docker this
 * machine talks to (Docker Desktop or Linux Engine):
 *
 *   mise exec -- bun apps/backend/scripts/container-exec-cost.ts \
 *     [--image orkestrator-v2:latest] [--execs 200] [--interval-ms 0] \
 *     [--watcher] [--repo <dir>] [--out <file.json>]
 *
 * - Host: wall latency and the `docker` CLI's own CPU and peak RSS per exec.
 * - Engine: CPU of dockerd, containerd and the container shims (their reaped
 *   children include `runc` and the exec'd command) per exec, sampled from
 *   `/proc` through a `--privileged --pid=host` helper container. On Linux
 *   Engine that is the host; on Docker Desktop it is the VM.
 * - Machine: busy CPU of the whole host or VM per exec, minus an idle
 *   baseline measured just before.
 * - Docker Desktop on macOS only: CPU of the host-side `com.docker.backend`
 *   processes (the API socket proxy) and of the virtual machine process
 *   (guest CPU plus hypervisor overhead), sampled with `ps`.
 *
 * Workloads: the Claude state read (B18, `claudeStateReadCommand`), and with
 * `--repo` the container status scan and tree walk against a copy of that
 * repository's HEAD. `--watcher` (an image with `container-worktree-signal`)
 * also starts `orkestrator-worktree-signal` on that copy and reports its
 * watches, set-up time, RSS and idle CPU, for the watcher-versus-walk
 * comparison. Containers are labelled `app=orkestrator-exec-cost` and removed
 * on exit; nothing else is touched.
 */

type Snapshot = { busy: number; total: number; engine: Record<string, number> };
type Run = { wallMs: number; cliCpuMs: number; cliRssMb: number };

const LABEL = "app=orkestrator-exec-cost";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function run(
  args: string[],
  options: { stdin?: string; allowFailure?: boolean } = {},
): Promise<Run & { stdout: string }> {
  const started = performance.now();
  const child = Bun.spawn(["docker", ...args], {
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const wallMs = performance.now() - started;
  if (code !== 0 && !options.allowFailure) {
    throw new Error(`docker ${args.slice(0, 2).join(" ")} failed: ${stderr.trim()}`);
  }
  const usage = child.resourceUsage();
  return {
    stdout,
    wallMs,
    cliCpuMs: usage ? Number(usage.cpuTime.total) / 1_000 : Number.NaN,
    // Bun reports maxRSS in bytes.
    cliRssMb: usage ? usage.maxRSS / (1024 * 1024) : Number.NaN,
  };
}

/** `/proc/stat` busy/total jiffies and engine process CPU (with reaped children). */
const SNAPSHOT_SCRIPT = `
read -r _ user nice system idle iowait irq softirq steal _ < /proc/stat
echo "cpu $((user + nice + system + irq + softirq + steal)) $((user + nice + system + idle + iowait + irq + softirq + steal))"
for p in /proc/[0-9]*; do
  comm=$(cat "$p/comm" 2>/dev/null) || continue
  case "$comm" in
    dockerd|containerd|containerd-shim*)
      # utime, stime and the reaped children's cutime, cstime (fields 14-17).
      awk -v c="$comm" '{ print "proc", c, $14 + $15 + $16 + $17 }' "$p/stat" 2>/dev/null
      ;;
  esac
done
`;

async function snapshot(sampler: string): Promise<Snapshot> {
  const { stdout } = await run(["exec", sampler, "sh", "-c", SNAPSHOT_SCRIPT]);
  const result: Snapshot = { busy: 0, total: 0, engine: {} };
  for (const line of stdout.split("\n")) {
    const [kind, name, value] = line.trim().split(/\s+/);
    if (kind === "cpu") {
      result.busy = Number(name);
      result.total = Number(value);
    } else if (kind === "proc" && name) {
      const group = name.startsWith("containerd-shim") ? "containerd-shim" : name;
      result.engine[group] = (result.engine[group] ?? 0) + Number(value);
    }
  }
  return result;
}

/** macOS Docker Desktop processes by role, in CPU milliseconds; empty elsewhere. */
function desktopHostCpu(): Record<string, number> {
  if (os.platform() !== "darwin") return {};
  const listing = Bun.spawnSync(["ps", "-A", "-o", "time=,args="]).stdout.toString();
  const totals: Record<string, number> = {};
  for (const line of listing.split("\n")) {
    const match = /^\s*(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s+(.*)$/.exec(line);
    if (!match) continue;
    const role = match[4]!.includes("com.docker.backend")
      ? "com.docker.backend"
      : match[4]!.includes("com.apple.Virtualization.VirtualMachine")
        ? "virtual-machine"
        : undefined;
    if (!role) continue;
    const ms = ((Number(match[1] ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1_000;
    totals[role] = (totals[role] ?? 0) + ms;
  }
  return totals;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? Number.NaN;
}

const round = (value: number) => Math.round(value * 100) / 100;

/** Jiffies are 1/CLK_TCK s; 100 on every supported kernel config we target. */
const JIFFY_MS = 10;

async function measure(
  name: string,
  sampler: string,
  execs: number,
  intervalMs: number,
  idleBusyPerMs: number,
  once: () => Promise<Run>,
) {
  const runs: Run[] = [];
  const before = await snapshot(sampler);
  const hostBefore = desktopHostCpu();
  const started = performance.now();
  for (let index = 0; index < execs; index += 1) {
    runs.push(await once());
    if (intervalMs > 0) await Bun.sleep(intervalMs);
  }
  const elapsedMs = performance.now() - started;
  const hostAfter = desktopHostCpu();
  const after = await snapshot(sampler);
  const desktopHost: Record<string, number> = {};
  for (const key of Object.keys(hostAfter)) {
    // Not idle-corrected: the VM process includes the guest's idle noise.
    desktopHost[key] = round(((hostAfter[key] ?? 0) - (hostBefore[key] ?? 0)) / execs);
  }
  const machineMs = ((after.busy - before.busy) * JIFFY_MS - idleBusyPerMs * elapsedMs) / execs;
  const engine: Record<string, number> = {};
  for (const key of new Set([...Object.keys(before.engine), ...Object.keys(after.engine)])) {
    engine[key] = round(
      (((after.engine[key] ?? 0) - (before.engine[key] ?? 0)) * JIFFY_MS) / execs,
    );
  }
  const wall = runs.map((entry) => entry.wallMs);
  const cpu = runs.map((entry) => entry.cliCpuMs);
  return {
    name,
    execs,
    wallMs: { p50: round(percentile(wall, 0.5)), p95: round(percentile(wall, 0.95)) },
    hostCliCpuMs: { p50: round(percentile(cpu, 0.5)), p95: round(percentile(cpu, 0.95)) },
    hostCliPeakRssMb: round(Math.max(...runs.map((entry) => entry.cliRssMb))),
    engineCpuMsPerExec: engine,
    machineBusyCpuMsPerExec: round(machineMs),
    ...(Object.keys(desktopHost).length > 0
      ? { desktopHostCpuMsPerExecUncorrected: desktopHost }
      : {}),
  };
}

async function main(): Promise<void> {
  const image = argument("--image") ?? "orkestrator-v2:latest";
  const execs = Number(argument("--execs") ?? 200);
  const intervalMs = Number(argument("--interval-ms") ?? 0);
  const repo = argument("--repo");
  const watcher = process.argv.includes("--watcher");
  const out = argument("--out");
  const docker = await run([
    "version",
    "--format",
    "{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}",
  ]);
  const info = await run(["info", "--format", "{{.OperatingSystem}} {{.KernelVersion}} {{.NCPU}}"]);
  const containers: string[] = [];
  try {
    const target = (
      await run([
        "run",
        "--detach",
        "--rm",
        "--label",
        LABEL,
        "--user",
        "node",
        "--entrypoint",
        "sleep",
        image,
        "infinity",
      ])
    ).stdout.trim();
    containers.push(target);
    const sampler = (
      await run([
        "run",
        "--detach",
        "--rm",
        "--label",
        LABEL,
        "--privileged",
        "--pid=host",
        "--entrypoint",
        "sleep",
        image,
        "infinity",
      ])
    ).stdout.trim();
    containers.push(sampler);
    await run([
      "exec",
      target,
      "sh",
      "-c",
      "printf 'waiting 1 0\\n' > /tmp/.claude-state-snapshot",
    ]);

    // Idle rate of the machine with both containers up and nothing exec'd.
    const idleBefore = await snapshot(sampler);
    const idleStarted = performance.now();
    await Bun.sleep(10_000);
    const idleAfter = await snapshot(sampler);
    const idleBusyPerMs =
      ((idleAfter.busy - idleBefore.busy) * JIFFY_MS) / (performance.now() - idleStarted);

    const workloads = [];
    const read = claudeStateReadCommand(target);
    workloads.push(
      await measure("claude-state-read", sampler, execs, intervalMs, idleBusyPerMs, () =>
        run(read.args),
      ),
    );

    let watcherReport: Record<string, unknown> | undefined;
    if (repo) {
      await run([
        "exec",
        "--user",
        "root",
        target,
        "sh",
        "-c",
        "mkdir -p /workspace && chown node:node /workspace",
      ]);
      const archive = Bun.spawnSync(["git", "-C", repo, "archive", "--format=tar", "HEAD"]);
      if (archive.exitCode !== 0) throw new Error("git archive failed");
      const tarPath = path.join(os.tmpdir(), `orkestrator-exec-cost-${process.pid}.tar`);
      await Bun.write(tarPath, archive.stdout);
      await run(["cp", tarPath, `${target}:/tmp/workspace.tar`]);
      await run([
        "exec",
        target,
        "sh",
        "-c",
        "cd /workspace && tar -xf /tmp/workspace.tar && git init -q -b main && git add -A && git -c user.email=a@b -c user.name=a commit -q -m base && echo edit >> README.md",
      ]);
      const status = buildContainerGitStatusScript("main", true);
      workloads.push(
        await measure("status-scan", sampler, Math.min(execs, 50), intervalMs, idleBusyPerMs, () =>
          run(["exec", target, "bash", "-lc", status]),
        ),
      );
      const walk = `cd /workspace && node -e ${quoteShell(CONTAINER_FILE_TREE_LISTER)} -- /workspace ${MAX_FILE_TREE_NODES}`;
      workloads.push(
        await measure("tree-walk", sampler, Math.min(execs, 50), intervalMs, idleBusyPerMs, () =>
          run(["exec", target, "bash", "-lc", walk]),
        ),
      );
      if (watcher) {
        const startedAt = performance.now();
        await run(["exec", "-i", target, "/usr/local/bin/orkestrator-worktree-signal", "start"], {
          stdin: 'url = "http://127.0.0.1:9/worktree-signal"\n',
        });
        // Established once inotifywait holds its watches; count them from fdinfo.
        let watches = 0;
        let establishedMs = Number.NaN;
        for (let attempt = 0; attempt < 600; attempt += 1) {
          const probe = await run(
            [
              "exec",
              target,
              "sh",
              "-c",
              "p=$(pgrep -x inotifywait) && cat /proc/$p/fdinfo/* 2>/dev/null | grep -c '^inotify wd:'",
            ],
            { allowFailure: true },
          );
          const count = Number(probe.stdout.trim());
          if (count > 0 && count === watches) {
            establishedMs = performance.now() - startedAt;
            break;
          }
          watches = count;
          await Bun.sleep(100);
        }
        const rss = async () =>
          Number(
            (
              await run([
                "exec",
                target,
                "sh",
                "-c",
                "pg=$(cat /tmp/.orkestrator-worktree-signal.pid); ps -o rss= --sid $pg | awk '{s+=$1} END {print s}'",
              ])
            ).stdout.trim(),
          ) / 1024;
        const cpu = async () =>
          (
            await run([
              "exec",
              target,
              "sh",
              "-c",
              "pg=$(cat /tmp/.orkestrator-worktree-signal.pid); ps -o cputimes= --sid $pg | awk '{s+=$1} END {print s}'",
            ])
          ).stdout.trim();
        const cpuBefore = await cpu();
        await Bun.sleep(30_000);
        watcherReport = {
          watches,
          establishedMs: round(establishedMs),
          rssMb: round(await rss()),
          idleCpuSecondsOver30s: Number(await cpu()) - Number(cpuBefore),
          // The kernel charges about 1 KiB of unswappable memory per watch on 64-bit.
          approxKernelWatchMemoryMb: round(watches / 1024),
        };
      }
    }

    const report = {
      at: new Date().toISOString(),
      host: `${os.platform()} ${os.arch()} ${os.cpus()[0]?.model ?? ""}`.trim(),
      docker: docker.stdout.trim(),
      engine: info.stdout.trim(),
      image,
      intervalMs,
      /** Busy CPU of the idle machine, in percent of one core. */
      idleMachineBusyCorePct: round(idleBusyPerMs * 100),
      workloads,
      ...(watcherReport ? { watcher: watcherReport } : {}),
    };
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (out) await writeFile(out, text);
    process.stdout.write(text);
  } finally {
    for (const container of containers)
      await run(["rm", "--force", container], { allowFailure: true });
  }
}

await main();
