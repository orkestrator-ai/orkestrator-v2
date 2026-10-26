import { randomUUID } from "node:crypto";

import { spawnPty, type PtyProcess } from "./pty.js";

/**
 * docker exec's client PID is not the container process. Give the workload a
 * PTY session group and an inherited identity; cancellation is confirmed inside
 * the container before retiring the host client.
 */
export function spawnContainerUserCommand(
  containerId: string,
  command: string,
  env: NodeJS.ProcessEnv,
): PtyProcess {
  const identity = randomUUID();
  const pidFile = `/tmp/orkestrator-user-command-${identity}.pid`;
  const process = spawnPty(
    "docker",
    [
      "exec",
      "-it",
      "-u",
      "node",
      "-w",
      "/workspace",
      "-e",
      `ORKESTRATOR_USER_COMMAND_ID=${identity}`,
      containerId,
      "bash",
      "-c",
      'ps -o pgid= -p $$ > "$1"; exec bash -lc "$2"',
      "orkestrator-user-command",
      pidFile,
      command,
    ],
    { cols: 120, rows: 40, env },
  );
  let termination: Promise<boolean> | undefined;
  const wrapped: PtyProcess = {
    ...process,
    onExit(callback) {
      return process.onExit((event) => {
        const report = (confirmed: boolean) => {
          if (confirmed) callback(event);
        };
        void wrapped
          .terminate()
          .then(report)
          .catch(() => undefined);
      });
    },
    terminate(options) {
      if (termination) return termination;
      termination = (async () => {
        const cleanup = Bun.spawn(
          [
            "docker",
            "exec",
            "-u",
            "node",
            containerId,
            "bash",
            "-c",
            // Match both the process group and the inherited identity, so even a
            // child that creates a new session or ignores terminal signals is killed.
            `file=$1; identity=$2
for attempt in {1..30}; do
  if [[ ! -f "$file" ]]; then sleep 0.1; continue; fi
  read -r group < "$file"
  [[ "$group" =~ ^[0-9]+$ ]] || exit 1
  live=()
  for entry in /proc/[0-9]*/stat; do
    [[ -r "$entry" ]] || continue
    pid=\${entry#/proc/}; pid=\${pid%/stat}
    [[ "$pid" == "$$" ]] && continue
    line=$(cat "$entry" 2>/dev/null) || continue
    fields=\${line##*) }
    read -r state parent pgroup rest <<< "$fields"
    [[ "$state" == Z ]] && continue
    if [[ "$pgroup" == "$group" ]] || grep -zqxF "ORKESTRATOR_USER_COMMAND_ID=$identity" "/proc/$pid/environ" 2>/dev/null; then
      live+=("$pid")
    fi
  done
  if (( \${#live[@]} == 0 )); then rm -f "$file"; exit 0; fi
  if (( attempt < 3 )); then kill -TERM "\${live[@]}" 2>/dev/null; else kill -KILL "\${live[@]}" 2>/dev/null; fi
  sleep 0.1
done
exit 1`,
            "orkestrator-cancel",
            pidFile,
            identity,
          ],
          { stdout: "ignore", stderr: "ignore" },
        );
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let confirmed = false;
        try {
          confirmed = await Promise.race([
            cleanup.exited.then((code) => code === 0),
            new Promise<false>((resolve) => {
              timeout = setTimeout(() => {
                cleanup.kill();
                resolve(false);
              }, 5_000);
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
        if (!confirmed) return false;
        return process.terminate(options);
      })();
      void termination.then(
        (confirmed) => {
          if (!confirmed) termination = undefined;
        },
        () => {
          termination = undefined;
        },
      );
      return termination;
    },
  };
  return wrapped;
}
