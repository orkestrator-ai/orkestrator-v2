import { readFileSync } from "node:fs";
import {
  type BackendExitCause,
  classifyBackendExit,
  isBunCrashReportLine,
} from "@orkestrator/protocol/backend-exit";

/**
 * What the desktop can say, without the message or stderr, about why the
 * Local backend stopped. Logged on `backend.exited`; every field is
 * content-free (docs/architecture/logging.md, "The essential event log").
 */
export interface BackendExitDiagnosis {
  exitCause: BackendExitCause;
  /** Milliseconds from the backend's ready line to its exit. */
  ranForMs: number;
  /** OOM kills the kernel counted in the backend's cgroup while it ran; null off Linux or when unreadable. */
  oomKills: number | null;
  crashReport: boolean;
}

export interface BackendExitWatchOptions {
  platform?: NodeJS.Platform;
  readText?: (file: string) => string;
  now?: () => number;
}

const readText = (file: string) => readFileSync(file, "utf8");

/** The unified (cgroup v2) hierarchy path of a process, from `/proc/<pid>/cgroup`. */
export function cgroupPathOf(procCgroup: string): string | null {
  for (const line of procCgroup.split("\n")) {
    if (!line.startsWith("0::")) continue;
    const relative = line.slice(3).trim();
    return relative.startsWith("/") ? relative : null;
  }
  return null;
}

/** `oom_kill` of a cgroup v2 `memory.events` file: kills by any OOM killer, in it or below it. */
export function oomKillCount(memoryEvents: string): number | null {
  const match = /^oom_kill (\d+)$/m.exec(memoryEvents);
  return match ? Number(match[1]) : null;
}

/**
 * Watches one backend child from its ready line to its exit. The cgroup is
 * resolved while the child is alive, because `/proc/<pid>` is gone by the time
 * it has exited; the cgroup itself outlives it, as the desktop is in it too.
 */
export class BackendExitWatch {
  private readonly platform: NodeJS.Platform;
  private readonly read: (file: string) => string;
  private readonly now: () => number;
  private readyAt: number | null = null;
  private memoryEventsFile: string | null = null;
  private oomKillsAtReady: number | null = null;
  private crashReport = false;

  constructor(options: BackendExitWatchOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.read = options.readText ?? readText;
    this.now = options.now ?? Date.now;
  }

  /** Call once the backend is ready. Never throws. */
  ready(pid: number | undefined): void {
    this.readyAt = this.now();
    if (this.platform !== "linux" || pid === undefined) return;
    const cgroup = this.tryRead(`/proc/${pid}/cgroup`, cgroupPathOf);
    if (!cgroup) return;
    const file = path(cgroup);
    const count = this.tryRead(file, oomKillCount);
    if (count === null) return;
    this.memoryEventsFile = file;
    this.oomKillsAtReady = count;
  }

  /** Call for every stderr line; only remembers whether Bun's crash report appeared. */
  stderrLine(line: string): void {
    if (!this.crashReport && isBunCrashReportLine(line)) this.crashReport = true;
  }

  /** Never throws. */
  diagnose(exit: {
    exitCode: number | null;
    signal: string | null;
    spawnError?: boolean;
  }): BackendExitDiagnosis {
    let oomKills: number | null = null;
    if (this.memoryEventsFile && this.oomKillsAtReady !== null) {
      const count = this.tryRead(this.memoryEventsFile, oomKillCount);
      if (count !== null) oomKills = Math.max(0, count - this.oomKillsAtReady);
    }
    return {
      exitCause: classifyBackendExit({ ...exit, oomKills, crashReport: this.crashReport }),
      ranForMs: this.readyAt === null ? 0 : Math.max(0, this.now() - this.readyAt),
      oomKills,
      crashReport: this.crashReport,
    };
  }

  private tryRead<T>(file: string, parse: (text: string) => T | null): T | null {
    try {
      return parse(this.read(file));
    } catch {
      return null;
    }
  }
}

function path(cgroup: string): string {
  return `/sys/fs/cgroup${cgroup === "/" ? "" : cgroup}/memory.events`;
}
