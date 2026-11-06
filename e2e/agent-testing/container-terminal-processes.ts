import { spawnSync } from "node:child_process";

/**
 * The processes of a fixture container, for specs that check what a closed
 * terminal leaves behind. Content-free: process IDs, session IDs and program
 * names only (`comm`, never a command line).
 *
 * A container terminal's shell is the session leader of its `docker exec -it`
 * TTY, so every process it starts shares its session ID unless it calls
 * `setsid` itself. A session ID names one terminal's processes.
 */
export type ContainerProcess = { pid: number; sid: number; comm: string };

export function containerProcesses(containerId: string): ContainerProcess[] {
  const result = spawnSync("docker", ["exec", containerId, "ps", "-eo", "pid=,sid=,comm="], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.status !== 0) throw new Error("docker exec ps failed");
  return result.stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), sid: Number(match[2]), comm: match[3]!.trim() }));
}

/** Session IDs of the container's processes named `comm`. */
export function containerSessionsRunning(containerId: string, comm: string): Set<number> {
  return new Set(
    containerProcesses(containerId)
      .filter((entry) => entry.comm === comm)
      .map((entry) => entry.sid),
  );
}

/** The container processes still in any of `sessions`. */
export function containerProcessesInSessions(
  containerId: string,
  sessions: ReadonlySet<number>,
): ContainerProcess[] {
  return containerProcesses(containerId).filter((entry) => sessions.has(entry.sid));
}

/**
 * PIDs recorded by container terminal shells of the image's `node` user
 * (`CONTAINER_TERMINAL_PID_RECORD_COMMAND`); numbers only.
 */
export function recordedTerminalShellPids(containerId: string): number[] {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "--user",
      "node",
      containerId,
      "sh",
      "-c",
      'for f in "/tmp/orkestrator-terminals-$(id -u)"/*.pid; do [ -f "$f" ] && head -c 16 "$f" && echo; done; true',
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  if (result.status !== 0) throw new Error("docker exec failed reading terminal records");
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map(Number);
}
